"""FTMS (Fitness Machine Service) BLE protocol implementation."""
import struct
from enum import IntEnum

FTMS_SERVICE_UUID          = "00001826-0000-1000-8000-00805f9b34fb"
FTMS_FEATURE_UUID          = "00002acc-0000-1000-8000-00805f9b34fb"
INDOOR_BIKE_DATA_UUID      = "00002ad2-0000-1000-8000-00805f9b34fb"
FTMS_STATUS_UUID           = "00002ada-0000-1000-8000-00805f9b34fb"
FTMS_CONTROL_POINT_UUID    = "00002ad9-0000-1000-8000-00805f9b34fb"
SUPPORTED_POWER_RANGE_UUID = "00002ad8-0000-1000-8000-00805f9b34fb"

CYCLING_POWER_SERVICE_UUID     = "00001818-0000-1000-8000-00805f9b34fb"
CYCLING_POWER_MEASUREMENT_UUID = "00002a63-0000-1000-8000-00805f9b34fb"


class OpCode(IntEnum):
    REQUEST_CONTROL  = 0x00
    RESET            = 0x01
    SET_TARGET_POWER = 0x05
    START_RESUME     = 0x07
    STOP_PAUSE       = 0x08
    RESPONSE         = 0x80


class ResultCode(IntEnum):
    SUCCESS              = 0x01
    NOT_SUPPORTED        = 0x02
    INVALID_PARAMETER    = 0x03
    OPERATION_FAILED     = 0x04
    CONTROL_NOT_PERMITTED = 0x05


def cmd_request_control() -> bytes:
    return bytes([OpCode.REQUEST_CONTROL])


def cmd_start_resume() -> bytes:
    return bytes([OpCode.START_RESUME])


def cmd_stop(pause: bool = False) -> bytes:
    return bytes([OpCode.STOP_PAUSE, 0x02 if pause else 0x01])


def cmd_set_target_power(watts: int) -> bytes:
    """ERG mode: set target power. watts clamped to [0, 2000]."""
    w = max(0, min(int(watts), 2000))
    return struct.pack("<Bh", OpCode.SET_TARGET_POWER, w)


def parse_cp_response(data: bytes) -> dict | None:
    """Parse a Control Point indication (0x80 response)."""
    if len(data) < 3 or data[0] != OpCode.RESPONSE:
        return None
    return {
        "request": data[1],
        "result": data[2],
        "success": data[2] == ResultCode.SUCCESS,
    }


def parse_indoor_bike_data(data: bytes) -> dict:
    """
    Parse Indoor Bike Data (0x2AD2).
    Returns dict with any of: speed (km/h), cadence (rpm), power (W), heart_rate (bpm).
    """
    if len(data) < 2:
        return {}
    flags = struct.unpack_from("<H", data, 0)[0]
    offset = 2
    result = {}

    # Bit 0 = "More Data" flag; when 0, instantaneous speed is present
    if not (flags & 0x01):
        if offset + 2 <= len(data):
            result["speed"] = struct.unpack_from("<H", data, offset)[0] * 0.01
            offset += 2

    # Bit 1: average speed
    if flags & 0x02:
        offset += 2

    # Bit 2: instantaneous cadence  (unit: 1/2 rpm)
    if flags & 0x04:
        if offset + 2 <= len(data):
            result["cadence"] = struct.unpack_from("<H", data, offset)[0] * 0.5
            offset += 2

    # Bit 3: average cadence
    if flags & 0x08:
        offset += 2

    # Bit 4: total distance (3 bytes)
    if flags & 0x10:
        offset += 3

    # Bit 5: resistance level
    if flags & 0x20:
        offset += 2

    # Bit 6: instantaneous power (INT16, watts)
    if flags & 0x40:
        if offset + 2 <= len(data):
            result["power"] = struct.unpack_from("<h", data, offset)[0]
            offset += 2

    # Bit 7: average power
    if flags & 0x80:
        offset += 2

    # Bit 8: expended energy (5 bytes)
    if flags & 0x100:
        offset += 5

    # Bit 9: heart rate (UINT8)
    if flags & 0x200:
        if offset + 1 <= len(data):
            result["heart_rate"] = data[offset]
            offset += 1

    return result


def parse_cycling_power(data: bytes) -> dict:
    """Parse Cycling Power Measurement (0x2A63)."""
    if len(data) < 4:
        return {}
    flags = struct.unpack_from("<H", data, 0)[0]
    power = struct.unpack_from("<h", data, 2)[0]
    result = {"power": power}
    offset = 4

    if flags & 0x01:   # pedal power balance
        offset += 1
    if flags & 0x04:   # accumulated torque
        offset += 2
    if flags & 0x10:   # wheel revolution data
        offset += 6
    if flags & 0x20:   # crank revolution data
        if offset + 4 <= len(data):
            result["crank_rev"]        = struct.unpack_from("<H", data, offset)[0]
            result["crank_event_time"] = struct.unpack_from("<H", data, offset + 2)[0]
            offset += 4

    return result


# Known trainer name fragments (case-insensitive) used during scanning
TRAINER_KEYWORDS = [
    "kickr", "zwift", "hub", "tacx", "neo", "flux",
    "hammer", "snap", "direto", "suito", "bkool", "cyclops",
]
