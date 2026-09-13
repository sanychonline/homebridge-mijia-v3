'use strict';

class XiaomiCameraPowerAccessory {
  constructor(platform, accessory, config) {
    this.platform = platform;
    this.accessory = accessory;
    this.config = config;

    const { Service, Characteristic } = platform.api.hap;

    accessory
      .getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Xiaomi')
      .setCharacteristic(Characteristic.Model, config.model || 'mijia.camera.v3')
      .setCharacteristic(Characteristic.SerialNumber, `${config.did}-power`);

    this.service = accessory.getService(Service.Switch)
      || accessory.addService(Service.Switch, config.switchName || `${config.name || 'Xiaomi Camera'} Power`);

    this.service
      .getCharacteristic(Characteristic.On)
      .onGet(() => this.getOn())
      .onSet((value) => this.setOn(value));
  }

  async getOn() {
    return this.platform.cloud.getCameraPower(this.config.did);
  }

  async setOn(value) {
    await this.platform.cloud.setCameraPower(this.config.did, value);
  }
}

module.exports = { XiaomiCameraPowerAccessory };
