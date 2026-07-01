"""BLE device manager – scan, connect, and control FTMS smart trainers."""
import asyncio
import logging
from typing import Callable, Optional

from bleak import BleakClient, BleakScanner
from bleak.backends.device import BLEDevice

from ftms import (
    FTMS_CONTROL_POINT_UUID,
    FTMS_SERVICE_UUID,
    FTMS_STATUS_UUID,
    INDOOR_BIKE_DATA_UUID,
    CYCLING_POWER_SERVICE_UUID,
    CYCLING_POWER_MEASUREMENT_UUID,
    TRAINER_KEYWORDS,
    cmd_request_control,
    cmd_set_target_power,
    cmd_start_resume,
    cmd_stop,
    parse_cp_response,
    parse_cycling_power,
    parse_indoor_bike_data,
)

log = logging.getLogger(__name__)


class BLEManager:
    def __init__(self):
        self._scanned: dict[str, dict] = {}

        self.trainer_client:  Optional[BleakClient]  = None
        self.trainer_name:    Optional[str]           = None
        self.pm_client:       Optional[BleakClient]   = None
        self.pm_name:         Optional[str]           = None

        self._control_ok      = False
        self._cp_event        = asyncio.Event()
        self._cp_result: dict = {}

    # ------------------------------------------------------------------ status

    def get_status(self) -> dict:
        return {
            "trainer_connected": bool(
                self.trainer_client and self.trainer_client.is_connected
            ),
            "trainer_name": self.trainer_name,
            "pm_connected": bool(self.pm_client and self.pm_client.is_connected),
            "pm_name": self.pm_name,
        }

    # ------------------------------------------------------------------ scan

    async def scan(self, duration: int = 10) -> list[dict]:
        found: dict[str, dict] = {}

        def on_detect(device: BLEDevice, adv):
            name = device.name or ""
            uuids = [str(u).lower() for u in adv.service_uuids]
            is_fitness = (
                FTMS_SERVICE_UUID.lower() in uuids
                or CYCLING_POWER_SERVICE_UUID.lower() in uuids
                or any(k in name.lower() for k in TRAINER_KEYWORDS)
            )
            if is_fitness and name:
                found[device.address] = {
                    "id":        device.address,
                    "name":      name,
                    "rssi":      adv.rssi,
                    "has_ftms":  FTMS_SERVICE_UUID.lower() in uuids,
                    "has_power": CYCLING_POWER_SERVICE_UUID.lower() in uuids,
                }

        scanner = BleakScanner(detection_callback=on_detect)
        await scanner.start()
        await asyncio.sleep(duration)
        await scanner.stop()

        self._scanned = found
        return list(found.values())

    # ----------------------------------------------------------------- connect

    async def connect(self, device_id: str, role: str = "trainer") -> bool:
        info = self._scanned.get(device_id)
        if not info:
            log.error("Device %s not in scan results", device_id)
            return False

        def disconnected_cb(client: BleakClient):
            log.warning("Device %s disconnected", client.address)
            if role == "trainer":
                self._control_ok = False

        try:
            client = BleakClient(device_id, disconnected_callback=disconnected_cb)
            await client.connect(timeout=15)
            if not client.is_connected:
                return False

            if role == "trainer":
                self.trainer_client = client
                self.trainer_name   = info["name"]
                self._control_ok    = False
            else:
                self.pm_client = client
                self.pm_name   = info["name"]

            log.info("Connected to %s as %s", info["name"], role)
            return True
        except Exception as exc:
            log.error("connect(%s) failed: %s", device_id, exc)
            return False

    async def disconnect_all(self):
        for client, label in [
            (self.trainer_client, "trainer"),
            (self.pm_client,      "power meter"),
        ]:
            if client and client.is_connected:
                try:
                    await client.disconnect()
                    log.info("Disconnected %s", label)
                except Exception as exc:
                    log.warning("disconnect %s: %s", label, exc)

        self.trainer_client = None
        self.trainer_name   = None
        self.pm_client      = None
        self.pm_name        = None
        self._control_ok    = False

    # --------------------------------------------------------- notifications

    async def start_notifications(self, broadcast: Callable):
        if self.trainer_client and self.trainer_client.is_connected:
            await self._subscribe_trainer(broadcast)
        if self.pm_client and self.pm_client.is_connected:
            await self._subscribe_pm(broadcast)

    async def _subscribe_trainer(self, broadcast: Callable):
        client = self.trainer_client
        try:
            services = client.services
            for svc in services:
                for char in svc.characteristics:
                    uuid = str(char.uuid).lower()

                    if uuid == INDOOR_BIKE_DATA_UUID.lower() and "notify" in char.properties:
                        def _bike(_, raw, _bc=broadcast):
                            d = parse_indoor_bike_data(bytes(raw))
                            asyncio.create_task(_bc({"type": "live_data", **d}))
                        await client.start_notify(char.uuid, _bike)
                        log.info("Subscribed: Indoor Bike Data")

                    elif uuid == CYCLING_POWER_MEASUREMENT_UUID.lower() and "notify" in char.properties:
                        def _cpm(_, raw, _bc=broadcast):
                            d = parse_cycling_power(bytes(raw))
                            asyncio.create_task(_bc({"type": "live_data", **d}))
                        await client.start_notify(char.uuid, _cpm)
                        log.info("Subscribed: Cycling Power (trainer)")

                    elif uuid == FTMS_CONTROL_POINT_UUID.lower() and (
                        "indicate" in char.properties or "notify" in char.properties
                    ):
                        def _cp(_, raw):
                            r = parse_cp_response(bytes(raw))
                            if r:
                                self._cp_result = r
                                self._cp_event.set()
                        await client.start_notify(char.uuid, _cp)
                        log.info("Subscribed: FTMS Control Point")

        except Exception as exc:
            log.error("subscribe trainer: %s", exc)

    async def _subscribe_pm(self, broadcast: Callable):
        client = self.pm_client
        try:
            for svc in client.services:
                for char in svc.characteristics:
                    if (
                        str(char.uuid).lower() == CYCLING_POWER_MEASUREMENT_UUID.lower()
                        and "notify" in char.properties
                    ):
                        def _pm(_, raw, _bc=broadcast):
                            d = parse_cycling_power(bytes(raw))
                            asyncio.create_task(_bc({"type": "live_data", **d}))
                        await client.start_notify(char.uuid, _pm)
                        log.info("Subscribed: power meter")
        except Exception as exc:
            log.error("subscribe pm: %s", exc)

    # ------------------------------------------------------------ ERG control

    async def acquire_control(self) -> bool:
        if not (self.trainer_client and self.trainer_client.is_connected):
            return False
        try:
            self._cp_event.clear()
            await self.trainer_client.write_gatt_char(
                FTMS_CONTROL_POINT_UUID, cmd_request_control(), response=True
            )
            try:
                await asyncio.wait_for(self._cp_event.wait(), timeout=4.0)
                ok = self._cp_result.get("success", False)
            except asyncio.TimeoutError:
                log.warning("CP timeout on RequestControl – assuming success")
                ok = True

            self._control_ok = ok
            if ok:
                log.info("FTMS control acquired")
            return ok
        except Exception as exc:
            log.error("acquire_control: %s", exc)
            return False

    async def start_training(self) -> bool:
        if not self._control_ok:
            await self.acquire_control()
        try:
            await self.trainer_client.write_gatt_char(
                FTMS_CONTROL_POINT_UUID, cmd_start_resume(), response=True
            )
            return True
        except Exception as exc:
            log.error("start_training: %s", exc)
            return False

    async def set_target_power(self, watts: int) -> bool:
        if not (self.trainer_client and self.trainer_client.is_connected):
            return False
        if not self._control_ok:
            if not await self.acquire_control():
                return False
        try:
            await self.trainer_client.write_gatt_char(
                FTMS_CONTROL_POINT_UUID, cmd_set_target_power(watts), response=True
            )
            log.debug("Set power → %dW", watts)
            return True
        except Exception as exc:
            log.error("set_target_power(%d): %s", watts, exc)
            self._control_ok = False   # may need to re-acquire
            return False

    async def stop_training(self):
        if not (self.trainer_client and self.trainer_client.is_connected):
            return
        try:
            await self.trainer_client.write_gatt_char(
                FTMS_CONTROL_POINT_UUID, cmd_stop(), response=True
            )
        except Exception as exc:
            log.error("stop_training: %s", exc)
