"use strict";

const { XiaomiCameraPlatform } = require("./platform");

module.exports = (api) => {
  api.registerPlatform("homebridge-mijia-v3", "Xiaomi Camera 1080P", XiaomiCameraPlatform);
};
