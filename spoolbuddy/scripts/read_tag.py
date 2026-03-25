#!/usr/bin/env python3
"""PN5180 NFC Tag Reader diagnostic script.

Standalone diagnostic — the PN5180 driver lives in
spoolbuddy/daemon/pn5180.py and is imported from there.

Supports: Bambu (MIFARE Classic) + NTAG (SpoolEase/OpenPrintTag)
"""

import logging
import sys
import time
from pathlib import Path

# Add daemon package to sys.path so we can import the driver
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from daemon.pn5180 import BAMBU_BLOCKS, PN5180

# Show driver debug output during diagnostics
logging.basicConfig(level=logging.DEBUG, format="  %(message)s")


def _print_hex_dump(data: bytes, label: str, bytes_per_line: int = 16):
    """Print a hex dump with ASCII sidebar."""
    for i in range(0, len(data), bytes_per_line):
        chunk = data[i : i + bytes_per_line]
        hex_str = " ".join(f"{b:02X}" for b in chunk)
        ascii_str = "".join(chr(b) if 32 <= b < 127 else "." for b in chunk)
        print(f"    {label}{i:3d}: {hex_str:<{bytes_per_line * 3}}|{ascii_str}|")


def main():
    print("=" * 60)
    print("PN5180 NFC Tag Reader")
    print("  Supports: Bambu (MIFARE Classic) + NTAG (SpoolEase/OpenPrintTag)")
    print("=" * 60)

    try:
        nfc = PN5180()
    except (OSError, RuntimeError, PermissionError) as e:
        print(f"\nERROR: Failed to initialize NFC reader: {e}")

        # Check if it's a resource conflict
        error_str = str(e).lower()
        is_resource_conflict = any(x in error_str for x in ["busy", "resource", "already in use", "permission denied"])

        if is_resource_conflict:
            print("\nGPIO/SPI RESOURCE IN USE: Another process is using the NFC reader.")
            print("This typically means the SpoolBuddy daemon is already reading tags.")
            print("\nTo run this diagnostic, stop the daemon first:")
            print("  sudo systemctl stop bambuddy")
            print("  # Run diagnostic")
            print("  .../read_tag.py")
            print("  # Restart daemon when done:")
            print("  sudo systemctl start bambuddy")
        else:
            print("\nCheck:")
            print("  - Correct GPIO chip is available (/dev/gpiochip0 or /dev/gpiochip4)")
            print("  - SPI device is available")
            print("  - GPIO and SPI permissions are correct")
            # Only print full traceback for unexpected errors
            import traceback

            traceback.print_exc()

        sys.exit(1)

    try:
        nfc.reset()
        ver = nfc.read_eeprom(0x10, 2)
        print(f"[1] Reset OK — product v{ver[1]}.{ver[0]}")

        nfc.load_rf_config(0x00, 0x80)  # ISO 14443A
        time.sleep(0.010)
        nfc.rf_on()
        time.sleep(0.030)
        nfc.set_transceive_mode()

        rf = nfc.read_reg(0x1D)
        print(f"[2] RF ON  (RF_STATUS=0x{rf:08X}, TX_RF={'ON' if rf & 1 else 'OFF'})")

        print("[3] Scanning for tag...")
        result = nfc.activate_type_a()

        if result is None:
            print("    No tag found.")
            sys.exit(1)

        uid, sak = result
        tag_types = {0x00: "NTAG", 0x08: "MIFARE Classic 1K", 0x18: "MIFARE Classic 4K"}
        print(f"    UID : {uid.hex().upper()}")
        print(f"    SAK : 0x{sak:02X} ({tag_types.get(sak, 'Unknown')})")

        if sak in (0x08, 0x18):
            # MIFARE Classic 1K or 4K — Bambu Lab tag
            print("[4] Reading Bambu tag data (MIFARE Classic)...")
            blocks = nfc.read_bambu_tag(uid)

            if blocks is None:
                print("    Failed to read tag data.")
                nfc.rf_off()
                sys.exit(1)

            print("[5] Tag data:")
            for block_num in BAMBU_BLOCKS:
                data = blocks[block_num]
                hex_str = " ".join(f"{b:02X}" for b in data)
                ascii_str = "".join(chr(b) if 32 <= b < 127 else "." for b in data)
                print(f"    Block {block_num:2d}: {hex_str}  |{ascii_str}|")

            raw = b""
            for block_num in BAMBU_BLOCKS:
                raw += blocks[block_num]
            print(f"\n    Raw payload ({len(raw)} bytes): {raw.hex().upper()}")

        elif sak == 0x00:
            # NTAG — SpoolEase / OpenPrintTag
            print("[4] Reading NTAG data (pages 4-20)...")
            ntag_data = nfc.read_ntag(uid)

            if ntag_data is None:
                print("    Failed to read NTAG data.")
                nfc.rf_off()
                sys.exit(1)

            print(f"[5] NTAG data ({len(ntag_data)} bytes):")
            _print_hex_dump(ntag_data, "page ")

        else:
            print(f"    Unsupported tag type (SAK=0x{sak:02X})")
            nfc.rf_off()
            sys.exit(1)

        nfc.rf_off()
        print("\n" + "=" * 60)
        print("Tag read complete!")
        print("=" * 60)

    except Exception as e:
        print(f"\nERROR: {e}")
        import traceback

        traceback.print_exc()
        sys.exit(1)
    finally:
        nfc.close()


if __name__ == "__main__":
    main()
