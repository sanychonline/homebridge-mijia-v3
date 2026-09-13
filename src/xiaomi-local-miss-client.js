"use strict";

const fs = require("fs");
const path = require("path");
const { XiaomiMissMediaReader } = require("./xiaomi-miss-media-reader");

class XiaomiLocalMissClient {
  constructor(platform, cloud, config) {
    this.platform = platform;
    this.cloud = cloud;
    this.config = config;
  }

  async startStream(options = {}) {
    if (!this.config.deviceKey) {
      throw new Error(
        `Local Xiaomi MISS streaming for ${this.config.name || this.config.did} requires deviceKey in config.json.`,
      );
    }

    const descriptor = await this.resolveDescriptor();
    const videoQuality = options.videoQuality
      || this.config.missVideoQuality
      || this.config.videoQuality
      || this.config.subtype
      || this.config.profile
      || descriptor.subtype;
    const reader = new XiaomiMissMediaReader(this.platform, descriptor, {
      audio: options.audio !== undefined ? Boolean(options.audio) : this.config.audio !== false,
      videoQuality,
      channel: this.config.missChannel ?? this.config.channel,
    });

    this.platform.log.info(
      `Resolved local Xiaomi MISS stream for ${this.config.name || this.config.did}: ${JSON.stringify(reader.toSafeSummary())}`,
    );

    await reader.open();
    return {
      url: reader.toMissUrl(),
      descriptor,
      reader,
    };
  }

  async resolveDescriptor() {
    const mode = this.config.cloudBootstrap || "fallback";
    const cached = mode !== "always" ? this.loadCachedDescriptor() : null;
    if (cached) {
      this.platform.log.info(`Using cached local Xiaomi MISS descriptor for ${this.config.name || this.config.did}`);
      return this.applyDescriptorOverrides(cached);
    }

    if (mode === "local") {
      throw new Error(`Local Xiaomi MISS descriptor cache is missing for ${this.config.name || this.config.did}; set cloudBootstrap=fallback once to refresh it, then switch back to local.`);
    }

    if (mode === "cacheOnly") {
      this.platform.log.warn(`cloudBootstrap=cacheOnly is a legacy setting. MISS descriptor cache is missing for ${this.config.name || this.config.did}; refreshing it once through Xiaomi Cloud session.`);
    }

    const descriptor = await this.cloud.getMissStreamDescriptor(this.config.did, {
      ip: this.config.ip || this.config.localip || this.config.localIp || this.config.host,
      model: this.config.model,
      subtype: this.config.subtype || this.config.profile || "sd",
      deviceKey: this.config.deviceKey,
    });
    this.saveCachedDescriptor(descriptor);
    return descriptor;
  }

  applyDescriptorOverrides(descriptor) {
    return {
      ...descriptor,
      did: String(this.config.did || descriptor.did),
      ip: this.config.ip || this.config.localip || this.config.localIp || this.config.host || descriptor.ip,
      model: this.config.model || descriptor.model,
      subtype: this.config.subtype || this.config.profile || descriptor.subtype || "sd",
      deviceKey: this.config.deviceKey || descriptor.deviceKey,
    };
  }

  descriptorCachePath() {
    if (this.config.descriptorCacheFile) {
      return this.config.descriptorCacheFile;
    }

    const storagePath = this.platform.api?.user?.storagePath?.() || process.cwd();
    return path.join(storagePath, ".xiaomi-1080p", "miss-descriptors.json");
  }

  loadCachedDescriptor() {
    const filePath = this.descriptorCachePath();
    if (!filePath || !fs.existsSync(filePath)) {
      return null;
    }

    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const descriptor = data[String(this.config.did)];
      if (!descriptor || !descriptor.clientPrivate || !descriptor.clientPublic || !descriptor.devicePublic || !descriptor.sign) {
        return null;
      }
      return descriptor;
    } catch (error) {
      this.platform.log.warn(`Could not read Xiaomi MISS descriptor cache for ${this.config.name || this.config.did}: ${error.message}`);
      return null;
    }
  }

  saveCachedDescriptor(descriptor) {
    const filePath = this.descriptorCachePath();
    if (!filePath || !descriptor) {
      return;
    }

    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      let data = {};
      if (fs.existsSync(filePath)) {
        data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      }
      data[String(this.config.did)] = descriptor;
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
      fs.chmodSync(filePath, 0o600);
      this.platform.log.info(`Saved local Xiaomi MISS descriptor cache for ${this.config.name || this.config.did}`);
    } catch (error) {
      this.platform.log.warn(`Could not save Xiaomi MISS descriptor cache for ${this.config.name || this.config.did}: ${error.message}`);
    }
  }
}

module.exports = { XiaomiLocalMissClient };
