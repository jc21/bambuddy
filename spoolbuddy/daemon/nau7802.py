"""NAU7802 24-bit ADC driver for load cell / scale applications.

I2C address: 0x2A
Bus: /dev/i2c-1 (GPIO2/GPIO3 on RPi)
"""

import logging
import os
import struct
import time

import smbus2

logger = logging.getLogger(__name__)


def _env_int(name: str, default: int) -> int:
    value = os.environ.get(name)
    if value is None or value == "":
        return default
    try:
        return int(value)
    except ValueError:
        return default


I2C_BUS = _env_int("SPOOLBUDDY_I2C_BUS", 1)
NAU7802_ADDR = 0x2A

# Register addresses
REG_PU_CTRL = 0x00
REG_CTRL1 = 0x01
REG_CTRL2 = 0x02
REG_ADCO_B2 = 0x12  # ADC output MSB
REG_ADCO_B1 = 0x13
REG_ADCO_B0 = 0x14  # ADC output LSB
REG_ADC = 0x15
REG_PGA = 0x1B
REG_PWR_CTRL = 0x1C
REG_REVISION = 0x1F

# PU_CTRL bits
PU_RR = 0x01  # Register reset
PU_PUD = 0x02  # Power up digital
PU_PUA = 0x04  # Power up analog
PU_PUR = 0x08  # Power up ready (read-only)
PU_CS = 0x10  # Cycle start
PU_CR = 0x20  # Cycle ready (read-only)
PU_OSCS = 0x40  # Oscillator select
PU_AVDDS = 0x80  # AVDD source select


class NAU7802:
    def __init__(self, bus: int = I2C_BUS, addr: int = NAU7802_ADDR):
        self._bus_num = bus
        self._bus = smbus2.SMBus(bus)
        self._addr = addr

    def close(self):
        self._bus.close()

    def read_reg(self, reg: int) -> int:
        return self._bus.read_byte_data(self._addr, reg)

    def write_reg(self, reg: int, val: int):
        self._bus.write_byte_data(self._addr, reg, val & 0xFF)

    def _update_bits(self, reg: int, mask: int, value: int):
        cur = self.read_reg(reg)
        self.write_reg(reg, (cur & ~mask) | (value & mask))

    def _set_bit(self, reg: int, bit: int, enabled: bool):
        mask = 1 << bit
        self._update_bits(reg, mask, mask if enabled else 0)

    def _set_field(self, reg: int, shift: int, width: int, value: int):
        mask = ((1 << width) - 1) << shift
        self._update_bits(reg, mask, value << shift)

    def init(self):
        """Initialize NAU7802 using the Adafruit library startup sequence."""

        # Reset
        self._set_bit(REG_PU_CTRL, 0, True)  # RR=1
        time.sleep(0.010)
        self._set_bit(REG_PU_CTRL, 0, False)  # RR=0
        self._set_bit(REG_PU_CTRL, 1, True)  # PUD=1
        time.sleep(0.001)

        # Enable digital + analog and allow analog section to settle.
        self._set_bit(REG_PU_CTRL, 1, True)  # PUD=1
        self._set_bit(REG_PU_CTRL, 2, True)  # PUA=1
        time.sleep(0.600)

        # Start conversion cycle (PU_CS bit 4) after power-up.
        self._set_bit(REG_PU_CTRL, 4, True)

        # Wait for power-up ready (PU_PUR bit 3)
        for _ in range(100):
            status = self.read_reg(REG_PU_CTRL)
            if status & PU_PUR:
                break
            time.sleep(0.001)
        else:
            raise TimeoutError("NAU7802 power-up timeout")

        # Check revision register low nibble (Adafruit expects 0xF).
        revision = self.read_reg(REG_REVISION)
        if (revision & 0x0F) != 0x0F:
            raise RuntimeError(f"Unexpected NAU7802 revision register: 0x{revision:02X}")

        logger.debug("NAU7802 revision=0x%02X", revision)

        # Internal LDO enable is PU_CTRL.AVDDS (bit 7); set LDO voltage to 3.0V.
        self._set_bit(REG_PU_CTRL, 7, True)  # AVDDS=1 (internal LDO)
        self._set_field(REG_CTRL1, shift=3, width=3, value=0b101)  # VLDO=3.0V

        # Gain: 128x (bits 2:0 of CTRL1 = 0b111)
        self._set_field(REG_CTRL1, shift=0, width=3, value=0b111)

        # Sample rate: 10 SPS (CTRL2 bits 6:4 = 0b000)
        self._set_field(REG_CTRL2, shift=4, width=3, value=0b000)

        # Adafruit tuning: disable ADC chopper clock (ADC bits 5:4 = 0b11)
        self._set_field(REG_ADC, shift=4, width=2, value=0b11)

        # Adafruit tuning: use low ESR caps (PGA bit 6 = 0)
        self._set_bit(REG_PGA, 6, False)

        # Start conversion cycle
        self._set_bit(REG_PU_CTRL, 4, True)

        # Flush the first reading — the NAU7802 always returns a stale
        # max-scale value (0x7FFFFF) on the first conversion after power-up.
        for _ in range(200):
            if self.data_ready():
                self.read_raw()  # discard
                break
            time.sleep(0.010)

        logger.debug("NAU7802 initialized: LDO=3.0V, gain=128x, rate=10SPS")

    def data_ready(self) -> bool:
        return bool(self.read_reg(REG_PU_CTRL) & PU_CR)

    def read_raw(self) -> int:
        """Read 24-bit signed ADC value."""
        b2 = self.read_reg(REG_ADCO_B2)
        b1 = self.read_reg(REG_ADCO_B1)
        b0 = self.read_reg(REG_ADCO_B0)
        raw = (b2 << 16) | (b1 << 8) | b0
        # Sign extend 24-bit to 32-bit
        if raw & 0x800000:
            raw |= 0xFF000000
            raw = struct.unpack("i", struct.pack("I", raw))[0]
        return raw
