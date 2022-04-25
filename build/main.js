var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target, mod));
var utils = __toESM(require("@iobroker/adapter-core"));
var import_objects = require("alcalzone-shared/objects");
var import_child_process = require("child_process");
var path = __toESM(require("path"));
var import_global = require("./lib/global");
var import_iobroker_objects = require("./lib/iobroker-objects");
var import_object_cache = require("./lib/object-cache");
var import_scanProcessInterface = require("./lib/scanProcessInterface");
var import_plugins = __toESM(require("./plugins"));
let enabledPlugins;
let services = [];
let allowNewDevices = true;
const ignoredNewDeviceIDs = /* @__PURE__ */ new Set();
let rssiUpdateInterval = 0;
let scanProcess;
const adapter = utils.adapter({
  name: "ble",
  ready: async () => {
    import_global.Global.adapter = adapter;
    import_global.Global.objectCache = new import_object_cache.ObjectCache(6e4);
    await import_global.Global.ensureInstanceObjects();
    const allowNewDevicesState = await adapter.getStateAsync("options.allowNewDevices");
    allowNewDevices = allowNewDevicesState && allowNewDevicesState.val != void 0 ? allowNewDevicesState.val : true;
    await adapter.setStateAsync("options.allowNewDevices", allowNewDevices, true);
    import_global.Global.adapter.log.info(`loaded plugins: ${import_plugins.default.map((p) => p.name).join(", ")}`);
    const enabledPluginNames = (adapter.config.plugins || "").split(",").map((p) => p.trim().toLowerCase()).concat("_default");
    enabledPlugins = import_plugins.default.filter((p) => enabledPluginNames.indexOf(p.name.toLowerCase()) > -1);
    import_global.Global.adapter.log.info(`enabled plugins: ${enabledPlugins.map((p) => p.name).join(", ")}`);
    if (adapter.config.services === "*") {
      services = [];
      import_global.Global.adapter.log.info(`monitoring all services`);
    } else {
      services = adapter.config.services.split(",").concat(...enabledPlugins.map((p) => p.advertisedServices)).reduce((acc, s) => acc.concat(s), []).map((s) => fixServiceName(s)).filter((s) => s !== "").reduce((acc, s) => {
        if (acc.indexOf(s) === -1)
          acc.push(s);
        return acc;
      }, []);
      import_global.Global.adapter.log.info(`monitored services: ${services.join(", ")}`);
    }
    if (adapter.config.rssiThrottle != null) {
      rssiUpdateInterval = Math.max(0, Math.min(1e4, adapter.config.rssiThrottle));
    }
    adapter.subscribeStates("*");
    adapter.subscribeObjects("*");
    if (!process.env.TESTING)
      startScanProcess();
  },
  unload: (callback) => {
    try {
      scanProcess == null ? void 0 : scanProcess.kill();
    } catch {
    }
    callback();
  },
  objectChange: (id, obj) => {
    if (!!obj) {
      import_global.Global.objectCache.updateObject(obj);
    } else {
      import_global.Global.objectCache.invalidateObject(id);
    }
  },
  stateChange: (id, state) => {
    if (/options\.allowNewDevices$/.test(id) && state != void 0 && !state.ack) {
      if (typeof state.val === "boolean") {
        allowNewDevices = state.val;
        import_global.Global.adapter.setState(id, state.val, true);
        if (allowNewDevices)
          ignoredNewDeviceIDs.clear();
      }
    }
  },
  message: async (obj) => {
    function respond(response) {
      if (obj.callback)
        adapter.sendTo(obj.from, obj.command, response, obj.callback);
    }
    const predefinedResponses = {
      ACK: { error: null },
      OK: { error: null, result: "ok" },
      ERROR_UNKNOWN_COMMAND: { error: "Unknown command!" },
      MISSING_PARAMETER: (paramName) => {
        return { error: 'missing parameter "' + paramName + '"!' };
      },
      COMMAND_RUNNING: { error: "command running" }
    };
    if (obj) {
      switch (obj.command) {
        case "getHCIPorts":
          (0, import_child_process.exec)("hciconfig | grep hci", (error, stdout, _stderr) => {
            if (error != null) {
              respond({ error });
              return;
            }
            const ports = [];
            const regex = /^hci(\d+)\:.+Bus\:\s(\w+)$/gm;
            let result;
            while (true) {
              result = regex.exec(stdout);
              if (!(result && result.length))
                break;
              const port = { index: +result[1], bus: result[2] };
              ports.push(port);
            }
            respond({ error: null, result: ports });
          });
          return;
        default:
          respond(predefinedResponses.ERROR_UNKNOWN_COMMAND);
          return;
      }
    }
  }
});
function startScanProcess() {
  const args = ["-s", ...services];
  if (adapter.config.hciDevice) {
    args.push("-d", adapter.config.hciDevice.toString());
  }
  adapter.log.info("starting scanner process...");
  scanProcess = (0, import_child_process.fork)(path.join(__dirname, "scanProcess"), args, {
    stdio: ["pipe", "pipe", "pipe", "ipc"]
  }).on("exit", (code, signal) => {
    if (!signal && code !== 0 && code !== import_scanProcessInterface.ScanExitCodes.RequireNobleFailed) {
      adapter.log.warn("scanner process crashed, restarting...");
      setImmediate(startScanProcess);
    } else {
      scanProcess = void 0;
    }
  });
  scanProcess.on("message", (0, import_scanProcessInterface.getMessageReviver)((message) => {
    var _a;
    switch (message.type) {
      case "connected":
        adapter.setState("info.connection", true, true);
        break;
      case "disconnected":
        adapter.setState("info.connection", false, true);
        break;
      case "discover":
        onDiscover(message.peripheral);
        break;
      case "driverState":
        adapter.setState("info.driverState", message.driverState, true);
        break;
      case "error":
      case "fatal":
        handleScanProcessError(message.error);
        break;
      case "log":
        adapter.log[(_a = message.level) != null ? _a : "info"](message.message);
        break;
    }
  }));
}
function fixServiceName(name) {
  if (name == null)
    return "";
  name = name.trim();
  for (const char of ["\r", "\n", "	", " "]) {
    name = name.replace(char, "");
  }
  name = name.replace(/^0x/, "");
  return name.toLowerCase();
}
async function onDiscover(peripheral) {
  if (peripheral == null)
    return;
  let serviceDataIsNotEmpty = false;
  let manufacturerDataIsNotEmpty = false;
  import_global.Global.adapter.log.debug(`discovered peripheral ${peripheral.address}`);
  import_global.Global.adapter.log.debug(`  has advertisement: ${peripheral.advertisement != null}`);
  if (peripheral.advertisement != null) {
    import_global.Global.adapter.log.debug(`  has serviceData: ${peripheral.advertisement.serviceData != null}`);
    if (peripheral.advertisement.serviceData != null) {
      import_global.Global.adapter.log.debug(`  serviceData = ${JSON.stringify(peripheral.advertisement.serviceData)}`);
      serviceDataIsNotEmpty = peripheral.advertisement.serviceData.length > 0;
    }
    import_global.Global.adapter.log.debug(`  has manufacturerData: ${peripheral.advertisement.manufacturerData != null}`);
    if (peripheral.advertisement.manufacturerData != null) {
      import_global.Global.adapter.log.debug(`  manufacturerData = ${peripheral.advertisement.manufacturerData.toString("hex")}`);
      manufacturerDataIsNotEmpty = peripheral.advertisement.manufacturerData.length > 0;
    }
  } else {
    return;
  }
  if (!adapter.config.allowEmptyDevices && !serviceDataIsNotEmpty && !manufacturerDataIsNotEmpty) {
    return;
  }
  const deviceId = peripheral.address;
  let plugin;
  for (const p of enabledPlugins) {
    if (p.isHandling(peripheral)) {
      import_global.Global.adapter.log.debug(`plugin ${p.name} is handling ${deviceId}`);
      plugin = p;
      break;
    }
  }
  if (!plugin) {
    import_global.Global.adapter.log.warn(`no handling plugin found for peripheral ${peripheral.id}`);
    return;
  }
  if (!allowNewDevices) {
    if (ignoredNewDeviceIDs.has(deviceId))
      return;
    if (!await import_global.Global.objectCache.objectExists(`${import_global.Global.adapter.namespace}.${deviceId}.rssi`)) {
      ignoredNewDeviceIDs.add(deviceId);
      return;
    }
  }
  await (0, import_iobroker_objects.extendState)(`${deviceId}.rssi`, {
    id: "rssi",
    common: {
      role: "value.rssi",
      name: "signal strength (RSSI)",
      desc: "Signal strength of the device",
      type: "number",
      read: true,
      write: false
    },
    native: {}
  });
  const rssiState = await adapter.getStateAsync(`${deviceId}.rssi`);
  if (rssiState == null || rssiState.ts + rssiUpdateInterval < Date.now()) {
    import_global.Global.adapter.log.debug(`updating rssi state for ${deviceId}`);
    await adapter.setStateAsync(`${deviceId}.rssi`, peripheral.rssi, true);
  }
  const context = plugin.createContext(peripheral);
  const objects = plugin.defineObjects(context);
  const values = plugin.getValues(context);
  if (objects == null)
    return;
  await (0, import_iobroker_objects.extendDevice)(deviceId, peripheral, objects.device);
  if (objects.channels != null && objects.channels.length > 0) {
    await Promise.all(objects.channels.map((c) => (0, import_iobroker_objects.extendChannel)(deviceId + "." + c.id, c)));
  }
  await Promise.all(objects.states.map((s) => (0, import_iobroker_objects.extendState)(deviceId + "." + s.id, s)));
  if (values != null) {
    import_global.Global.adapter.log.debug(`${deviceId} > got values: ${JSON.stringify(values)}`);
    for (let [stateId, value] of (0, import_objects.entries)(values)) {
      stateId = stateId.replace(/[\(\)]+/g, "").replace(" ", "_");
      const iobStateId = `${adapter.namespace}.${deviceId}.${stateId}`;
      if (await import_global.Global.objectCache.getObject(iobStateId) != null) {
        import_global.Global.adapter.log.debug(`setting state ${iobStateId}`);
        await adapter.setStateChangedAsync(iobStateId, value != null ? value : null, true);
      } else {
        import_global.Global.adapter.log.warn(`skipping state ${iobStateId} because the object does not exist`);
      }
    }
  } else {
    import_global.Global.adapter.log.debug(`${deviceId} > got no values`);
  }
}
function handleScanProcessError(err) {
  var _a, _b, _c;
  if (/compatible USB Bluetooth/.test(err.message) || /LIBUSB_ERROR_NOT_SUPPORTED/.test(err.message)) {
    terminate("No compatible BLE 4.0 hardware found!");
  } else if (/NODE_MODULE_VERSION/.test(err.message) && ((_a = adapter.supportsFeature) == null ? void 0 : _a.call(adapter, "CONTROLLER_NPM_AUTO_REBUILD"))) {
    terminate("A dependency requires a rebuild.", 13);
  } else if (err.message.includes(`The value of "offset" is out of range`)) {
    ((_b = adapter == null ? void 0 : adapter.log) != null ? _b : console).error(err.message);
  } else if (err.message.includes("EAFNOSUPPORT")) {
    terminate("Unsupported Address Family (EAFNOSUPPORT). If ioBroker is running in a Docker container, make sure that the container uses host mode networking.");
  } else {
    ((_c = adapter == null ? void 0 : adapter.log) != null ? _c : console).error(err.message);
  }
}
function terminate(reason = "no reason given", exitCode = 11) {
  var _a;
  if (adapter) {
    adapter.log.error(`Terminating because ${reason}`);
    (_a = adapter.terminate) == null ? void 0 : _a.call(adapter, reason, exitCode);
  }
  return process.exit(exitCode);
}
//# sourceMappingURL=main.js.map
