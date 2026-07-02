'use strict';

/* ═══════════════════════════════════════════════════════════════════
   BLEWebManager – Web Bluetooth implementation for FreeTrain web app.
   Replaces Python/bleak. Requires Chrome/Edge (not Safari/Firefox).
═══════════════════════════════════════════════════════════════════ */

class BLEWebManager {
  constructor() {
    this._device      = null;
    this._server      = null;
    this._ftmsCP      = null;   // FTMS Control Point for ERG
    this._onData      = null;   // callback(msg)
    this._trainerName = null;
  }

  static isSupported() {
    return !!navigator.bluetooth;
  }

  // Opens the native browser device picker. Returns device info or null if cancelled.
  async requestDevice() {
    try {
      this._device = await navigator.bluetooth.requestDevice({
        filters: [
          { services: [0x1826] },   // FTMS (most smart trainers)
          { services: [0x1818] },   // Cycling Power Service
        ],
        optionalServices: [0x1826, 0x1818, 0x180D],
      });
      return { id: this._device.id, name: this._device.name || 'Unnamed Device' };
    } catch (e) {
      if (e.name === 'NotFoundError') return null;   // user cancelled
      throw e;
    }
  }

  async connect(onData) {
    if (!this._device) return false;
    this._onData = onData;
    try {
      this._server = await this._device.gatt.connect();
      this._trainerName = this._device.name || 'Smart Trainer';

      this._device.addEventListener('gattserverdisconnected', () => {
        this._emit({ type: 'device_status', trainer_connected: false, trainer: null, hr_connected: false });
      });

      // Try FTMS first, fall back to Cycling Power Service
      const ok = (await this._connectFTMS()) || (await this._connectCyclingPower());
      if (ok) {
        this._emit({
          type:             'device_status',
          trainer_connected: true,
          trainer:           this._trainerName,
          hr_connected:      false,
          connect_success:   true,
        });
      }
      return ok;
    } catch (e) {
      console.error('BLE connect:', e);
      return false;
    }
  }

  async disconnect() {
    try { if (this._server?.connected) this._server.disconnect(); } catch (_) {}
    this._device = null; this._server = null; this._ftmsCP = null;
    this._trainerName = null;
  }

  async setTargetPower(watts) {
    if (!this._ftmsCP) return;
    watts = Math.max(0, Math.round(watts));
    try {
      await this._ftmsCP.writeValueWithResponse(
        new Uint8Array([0x05, watts & 0xFF, (watts >> 8) & 0xFF])
      );
    } catch (_) {}   // trainer may ignore — non-fatal
  }

  getStatus() {
    return {
      trainer_connected: !!(this._server?.connected),
      trainer:           this._trainerName,
      hr_connected:      false,
    };
  }

  // ── Private ────────────────────────────────────────────────────────

  async _connectFTMS() {
    try {
      const svc = await this._server.getPrimaryService(0x1826);

      // Control point for ERG mode
      try {
        this._ftmsCP = await svc.getCharacteristic(0x2AD9);
        await this._ftmsCP.writeValueWithResponse(new Uint8Array([0x00]));
      } catch (_) { console.warn('FTMS control point unavailable'); }

      // Indoor Bike Data → power + cadence
      try {
        const bikeData = await svc.getCharacteristic(0x2AD2);
        await bikeData.startNotifications();
        bikeData.addEventListener('characteristicvaluechanged',
          e => this._parseFTMSBikeData(e.target.value));
      } catch (_) { console.warn('Indoor Bike Data unavailable'); }

      return true;
    } catch (_) { return false; }
  }

  async _connectCyclingPower() {
    try {
      const svc  = await this._server.getPrimaryService(0x1818);
      const char = await svc.getCharacteristic(0x2A63);
      await char.startNotifications();
      char.addEventListener('characteristicvaluechanged',
        e => this._parseCyclingPower(e.target.value));
      return true;
    } catch (_) { return false; }
  }

  _parseFTMSBikeData(dv) {
    if (dv.byteLength < 2) return;
    const flags  = dv.getUint16(0, true);
    let offset   = 2;
    let power    = null;
    let cadence  = null;

    // Bit 0 = "More Data": if 0, Instantaneous Speed present (uint16)
    if (!(flags & 0x0001)) offset += 2;
    if  (flags & 0x0002)   offset += 2;   // Average Speed
    if  (flags & 0x0004) { cadence = dv.getUint16(offset, true) / 2; offset += 2; }
    if  (flags & 0x0008)   offset += 2;   // Average Cadence
    if  (flags & 0x0010)   offset += 3;   // Total Distance (uint24)
    if  (flags & 0x0020)   offset += 2;   // Resistance Level
    if  (flags & 0x0040) { power   = dv.getInt16(offset, true); }

    this._emit({
      type:    'live_data',
      power:   power   !== null ? Math.max(0, power)        : null,
      cadence: cadence !== null ? Math.round(cadence)       : null,
      hr:      null,
    });
  }

  _parseCyclingPower(dv) {
    if (dv.byteLength < 4) return;
    this._emit({ type: 'live_data', power: Math.max(0, dv.getInt16(2, true)), cadence: null, hr: null });
  }

  _emit(msg) {
    if (this._onData) this._onData(msg);
  }
}
