#!/usr/bin/env python3
"""NAU7802 Scale Diagnostic.

Standalone diagnostic script — the NAU7802 driver lives in
spoolbuddy/daemon/nau7802.py and is imported from there.
"""

import sys
import time
from pathlib import Path

import smbus2

# Add daemon package to sys.path so we can import the driver
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from daemon.nau7802 import I2C_BUS, NAU7802, NAU7802_ADDR


def main():
    print("=" * 60)
    print("NAU7802 Scale Diagnostic")
    print("=" * 60)

    print(f"Configured bus: {I2C_BUS}, address: 0x{NAU7802_ADDR:02X}")

    # Probe both common I2C buses and show where devices are actually visible.
    found_by_bus: dict[int, list[int]] = {}
    for bus_num in (0, 1):
        found_by_bus[bus_num] = []
        try:
            with smbus2.SMBus(bus_num) as probe_bus:
                for addr in range(0x03, 0x78):
                    try:
                        probe_bus.read_byte(addr)
                        found_by_bus[bus_num].append(addr)
                    except OSError:
                        continue
        except FileNotFoundError:
            continue
        except PermissionError:
            continue

    for bus_num, addrs in found_by_bus.items():
        if addrs:
            pretty = " ".join(f"0x{a:02X}" for a in addrs)
            print(f"Bus {bus_num} devices: {pretty}")
        else:
            print(f"Bus {bus_num} devices: (none)")

    if NAU7802_ADDR not in found_by_bus.get(I2C_BUS, []):
        for alt in (1, 0):
            if alt != I2C_BUS and NAU7802_ADDR in found_by_bus.get(alt, []):
                print(f"\nHint: NAU7802 (0x{NAU7802_ADDR:02X}) appears on bus {alt}, not configured bus {I2C_BUS}.")
                print(f"Try: SPOOLBUDDY_I2C_BUS={alt} .../scale_diag.py")
                break

    scale = NAU7802()
    try:
        print("[1] Initializing...")
        scale.init()
        print("  Initialized OK")

        print("[2] Waiting for first reading...")
        for _ in range(200):
            if scale.data_ready():
                break
            time.sleep(0.010)
        else:
            print("    Timeout waiting for data ready")
            sys.exit(1)

        print("[3] Reading 10 samples (10 SPS = ~1 second)...")
        readings = []
        for i in range(10):
            # Wait for data ready
            for _ in range(200):
                if scale.data_ready():
                    break
                time.sleep(0.010)
            raw = scale.read_raw()
            readings.append(raw)
            print(f"    Sample {i + 1:2d}: {raw:>10d}")

        avg = sum(readings) / len(readings)
        spread = max(readings) - min(readings)
        print(f"\n    Average: {avg:>10.0f}")
        print(f"    Min:     {min(readings):>10d}")
        print(f"    Max:     {max(readings):>10d}")
        print(f"    Spread:  {spread:>10d}")

        print("\n" + "=" * 60)
        print("Diagnostic complete!")
        print("=" * 60)

    except Exception as e:
        print(f"\nERROR: {e}")
        is_known_error = False

        if isinstance(e, OSError):
            if e.errno == 16:  # Device or resource busy
                is_known_error = True
                print("\nI2C DEVICE BUSY (Errno 16): Another process is using the I2C bus.")
                print("This typically means the SpoolBuddy daemon is already reading the scale.")
                print("\nTo run this diagnostic, stop the daemon first:")
                print("  sudo systemctl stop bambuddy")
                print("  # Run diagnostic")
                print("  .../scale_diag.py")
                print("  # Restart daemon when done:")
                print("  sudo systemctl start bambuddy")
            elif e.errno == 121:
                is_known_error = True
                print("\nI2C NACK (Errno 121): the device did not acknowledge reads at 0x2A.")
                print("Check:")
                print("  - NAU7802 SDA/SCL are on the configured bus pins")
                print("  - 3.3V and GND are correct and stable")
                print("  - Sensor address is really 0x2A")
                print("  - No loose wire or swapped SDA/SCL")
            else:
                print(f"\nI2C Error (Errno {e.errno}): {e}")

        # Only print full traceback for unexpected errors
        if not is_known_error:
            import traceback

            traceback.print_exc()

        sys.exit(1)
    finally:
        scale.close()


if __name__ == "__main__":
    main()
