/// Import Modules ///
const WebHooks = require("node-webhooks");
const fs = require("fs");
const Express = require("express");
const ssdp = require("./ssdp");
const colorout = require("./coreoutput");
const request = require("request");
const mqtt = require("mqtt");
const yaml = require("node-yaml");
const ip = require("ip");
const WebSocket = require('ws');

const CONFIG_FILE = "../res/config.yaml";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8060;

let conf;
let port;
let host;
let app;
let server;
let webHooks;
let mqttClient;
let wsClient;

let camillaDSPConfig = {volumeMax: 40, volumeMin: -20};
let stateMgmt = {volume: 0, muted: false};

// Array of client's IP-addresses. Clients are Logitech Harmony Hubs
let clients = [];

function init() {
    conf = yaml.readSync(CONFIG_FILE);
    if (conf.webserverConfig.hasOwnProperty("bindHost") && conf.webserverConfig.bindHost != "") {
        host = conf.webserverConfig.bindHost;
        if (host == "0.0.0.0") {
            colorout.log("debug", "[Webserver] Binding to all available local IPs; one is " + ip.address());
        } else {
            colorout.log("debug", "[Webserver] Found webserver-host in config-file. Using " + host);
        }
    } else {
        host = DEFAULT_HOST;
        colorout.log("debug", "[Webserver]: Found no webserver-host in config-file. Falling back to " + host);
    }

    if (conf.webserverConfig.hasOwnProperty("port") && conf.webserverConfig.port != "") {
        port = conf.webserverConfig.port;
        colorout.log("debug", "[Webserver] Found port in config-file. Using " + port);
    } else {
        port = DEFAULT_PORT;
        colorout.log("debug", "[Webserver] Found no port in config-file. Falling back to " + port);
    }

    app = Express();

    webHooks = new WebHooks({ db: {} });

    request.shouldKeepAlive = false;

    attachWebhooks();

    configureWebserverRoutes();

    if (host == "0.0.0.0") {
        ssdp.run("http://" + ip.address() + ":" + port + "/");
    } else {
        ssdp.run("http://" + host + ":" + port + "/");
    }

    process.on("SIGINT", () => {
        colorout.log("info", "[Webserver] Shutting down");
        server.close();
        process.exit();
    });

    if (host == "0.0.0.0") {
        // bind to all IPs.
        server = app.listen(port);
    } else {
        server = app.listen(port, host);
    }

    let mqttConfig = conf.mqttConfig;
    if (mqttConfig.hasOwnProperty("serverUrl") && mqttConfig.hasOwnProperty("serverUsername") && mqttConfig.hasOwnProperty("serverPassword") && mqttConfig.enabled == true) {
        connectMqttServer();
    }

    let websocketConfig = conf.websocketConfig;
    console.log('websocketConfig', websocketConfig);
    if (typeof websocketConfig !== 'undefined' && websocketConfig.hasOwnProperty("enabled") && websocketConfig.enabled == true && websocketConfig.hasOwnProperty("serverUrl")) {

        console.log('hi there');
        wsClient = connectWebsocketServer();
    }

    if (host == "0.0.0.0") {
        colorout.log("info", "[Webserver] Configuration Menu available at http://" + ip.address() + ":" + port + "/config/");
    } else {
        colorout.log("info", "[Webserver] Configuration Menu available at http://" + host + ":" + port + "/config/");
    }
}

function attachWebhooks() {
    conf.buttons.forEach(function(button) {
        webHooks.remove(button.name);
        if (button.action == "POST") webHooks.add(button.name, button.url);
    });
}

function connectWebsocketServer(){



    console.log('connectWebsocketServer will try ', conf.websocketConfig.serverUrl);
    wsClient = new WebSocket(conf.websocketConfig.serverUrl , { },

        //{headers: {Connection: 'Upgrade',}}
        );

    wsClient.on('open', function open() {
        console.log('WS connected');
        //wsClient.send(Date.now());

        setTimeout(function timeout() {
            console.log('Sending GetVolume');
            wsClient.send('"GetVolume"');
        }, 100);

        setTimeout(function timeout() {
            let msg = JSON.stringify({"SetUpdateInterval": 500});
            console.log('Sending SetUpdateInterval', msg);
            wsClient.send(msg);
        }, 1000);
    });

    wsClient.on('close', function close() {
        console.log('WS disconnected');
    });

    wsClient.on('message', function message(data) {
        //console.log(`ws received: ${Date.now()} `, data);

        console.log('WS received: %s', data);

        if (data.indexOf('GetVolume') > -1){
            let parsed = JSON.parse(Buffer.from(data).toString());
            stateMgmt.volume = parsed.GetVolume.value;
            console.log('WS stateMgmt volume', parsed.GetVolume.value);
        }
        if (data.indexOf('GetMute') > -1){
            let parsed = JSON.parse(Buffer.from(data).toString());
            stateMgmt.muted = parsed.GetMute.value;
            console.log('WS stateMgmt muted', stateMgmt.muted);
        }


        /*
        setTimeout(function timeout() {
            //console.log('Sending GetVolume');
            //wsClient.send({"GetVolume"});
        }, 2000);

         */
    });

    wsClient.on('error', function message(data) {
        //console.log(`ws received: ${Date.now()} `, data);
        console.log('WS error: %s', data);
    });

    return wsClient;


}

function connectMqttServer() {
    // TODO check if client is connected
    mqttClient = mqtt.connect(conf.mqttConfig.serverUrl, {
        username: conf.mqttConfig.serverUsername,
        password: conf.mqttConfig.serverPassword,
        reconnectPeriod: 0,
        connectTimeout: 5 * 1000
    });
    mqttClient.on("connect", function() {
        colorout.log("debug", "[MQTT-Connection] connected to MQTT-server");
    })
    mqttClient.on("error", function() {
        colorout.log("error", "[MQTT-Connection] could not connect to MQTT-server");
    });
}

function configureWebserverRoutes() {
    // server static content from public directory (http://.../config/*)
    app.use(Express.static('res/public'));
    // automatically interpret incoming post messages as JSON if Content-Type=application/json
    app.use(Express.json());

    // log all requests to debug
    app.use((req, res, next) => {
        colorout.log("debug", "[Webserver] " + req.method + " " + req.url + " from " + req.ip);
        next();
    });

    /// Send RootResponse.xml ///
    app.get('/', (req, res) => {
        if (!clients.includes(req.ip)) {
            clients.push(req.ip);
            colorout.log("info", "[Webserver] Logitech Hub at " + req.ip + " found me! Sending RootResponse.xml...");
        }
        res.type('application/xml');
        res.send(fs.readFileSync('res/RootResponse.xml', 'utf8'));
        res.end();
    });

    /// Button Event Handler ///
    app.post('/keypress/:action', function(req, res) {
        triggerAction(req.params['action']);
        res.end();
    });

    ///
    /// HarmonySpan Configuration API
    ///

    // get all buttons config
    app.get('/buttons/', function(req, res) {
        if (!req.accepts('json')) {
            res.sendStatus(415);
        } else {
            res.set('Content-Type', 'application/json');
            res.send(JSON.stringify(conf.buttons));
        }
    });

    // get specific button config
    app.get('/buttons/:id', function(req, res) {
        if (!req.accepts('json')) {
            res.sendStatus(415);
        } else {
            let id = req.params['id'];
            if (!id.match(/[0-9]{1,2}/) || parseInt(id) < 0 || parseInt(id) > conf.buttons.length - 1) {
                res.send(404);
            } else {
                res.set('Content-Type', 'application/json');
                res.send(conf.buttons[id]);
            }
        }
    });


    // set specific button's config
    app.put('/buttons/:id', function(req, res) {
        // TODO validate
        let data = req.body;
        conf.buttons[data.id] = data;
        res.sendStatus(204);
        yaml.writeSync(CONFIG_FILE, conf);
        attachWebhooks();
        colorout.log("debug", "[Core] Updated config file.");
    });

    // get MQTT server config
    app.get('/mqttconfig', function(req, res) {
        res.contentType('application/json');
        res.send(JSON.stringify(conf.mqttConfig));
    });

    // set MQTT server config
    app.post('/mqttconfig', function(req, res) {
        let data = req.body;
        let enabledBefore = conf.mqttConfig.enabled;
        let enabledAfter = data.enabled;
        if (enabledBefore != enabledAfter) {

        }
        conf.mqttConfig = data;
        yaml.writeSync(CONFIG_FILE, conf);
        colorout.log("debug", "[Core] Updated config file.");
        if (enabledBefore != enabledAfter) {
            if (enabledAfter) {
                connectMqttServer();
            } else {
                mqttClient.end();
            }
        }
        res.sendStatus(204);
    });

    app.get('/mqttconnected', function(req, res) {
        res.set("Content-Type", "application/json");
        res.send("{\"connected\": " + mqttClient.connected + " }");
    });

    // get websocket server config
    app.get('/websocketconfig', function(req, res) {
        res.contentType('application/json');
        res.send(JSON.stringify(conf.websocketConfig));
    });

    // set MQTT server config
    app.post('/websocketconfig', function(req, res) {
        let data = req.body;
        let enabledBefore = conf.websocketConfig.enabled;
        let enabledAfter = data.enabled;
        if (enabledBefore != enabledAfter) {

        }
        conf.websocketConfig = data;
        yaml.writeSync(CONFIG_FILE, conf);
        colorout.log("debug", "[Core] Updated config file.");
        if (enabledBefore != enabledAfter) {
            if (enabledAfter) {
                wsClient = connectWebsocketServer();
            } else {
                wsClient.close();
            }
        }
        res.sendStatus(204);
    });

    app.get('/websocketconnected', function(req, res) {
        res.set("Content-Type", "application/json");
        res.send("{\"connected\": " + (wsClient.readyState === wsClient.OPEN ? true : false) + " }");
    });
}

function triggerAction(buttonFunction) {
    let buttonIndex = getButtonIndex(buttonFunction);
    let button = conf.buttons[buttonIndex];

    colorout.log("debug", "[triggerAction] button: " + buttonFunction);

    if (button.enabled) {
        switch (button.action) {
            case "GET":
                request(button.url, function(error, response, body) {
                    if (error != null) {
                        colorout.log("error", "[Webserver] HTTP GET: error: " + error);
                    } else {
                        colorout.log("debug", "[Webserver] HTTP GET: " + response.statusCode);
                    }
                });
                break;
            case "POST":
                webHooks.trigger(button.name, JSON.parse(button.postPayload), button.httpHeaders);
                // console.log(JSON.parse(button.postPayload));
                break;
            case "MQTT":
                if (mqttClient && mqttClient.connected) {
                    mqttClient.publish(button.mqttTopic, button.mqttMessage);
                    colorout.log("debug", "[MQTT-Connection] Sent mqtt message");
                } else {
                    // TODO try reconnect
                    colorout.log("error", "[MQTT-Connection] MQTT not connected");
                }
                break;
            case "WEBSOCKET":
                if (wsClient && wsClient.readyState === wsClient.OPEN) {

                    if (button.websocketMessage.indexOf('SetVolume') > -1
                        && (button.websocketMessage.indexOf('changeBy') > -1)){
                        // If the user has specified setVolume with a relative setting like +10 or -5

                        let parsed = JSON.parse(button.websocketMessage);

                        let max = 130;
                        if (parsed.SetVolume.hasOwnProperty('max')){
                            max = parsed.SetVolume.max;
                        }
                        let min = -100;
                        if (parsed.SetVolume.hasOwnProperty('min')){
                            min = parsed.SetVolume.min;
                        }

                        colorout.log("debug", "[WEBSOCKET-Connection] Relative volume change " + parsed.SetVolume);

                        wsClient.send("\"GetVolume\"");

                        setTimeout(function () {
                            //{"SetVolume": {"value": 5, "type": "relative", "max": 40, "min":-20}}
                            colorout.log("debug", "[WEBSOCKET-Connection] after timeout");

                            let target = stateMgmt.volume + parsed.SetVolume.changeBy;
                            if (target > max){
                                target = max;
                            }
                            else if (target < min){
                                target = min;
                            }

                            parsed.SetVolume = target;
                            wsClient.send(JSON.stringify(parsed));

                         }, 120);


                    }
                    else if (button.websocketMessage.indexOf('SetMute') > -1 && button.websocketMessage.indexOf('toggle') > -1){
                        // Change it into a current state toggle
                        let parsed = JSON.parse(button.websocketMessage);
                        //colorout.log("debug", "[WEBSOCKET-Connection] SetMute toggle " + parsed);
                        wsClient.send("\"GetMute\"");
                        setTimeout(function () {
                            //{"SetVolume": {"value": 5, "type": "relative", "max": 40, "min":-20}}

                            parsed.SetMute = !stateMgmt.muted;

                            colorout.log("debug", "[WEBSOCKET-Connection] sending SetMute " + parsed.SetMute );

                            wsClient.send(JSON.stringify(parsed));
                        }, 120);
                    }

                    else {
                        wsClient.send(button.websocketMessage);
                    }


                    colorout.log("debug", "[WEBSOCKET-Connection] Sent websocket message: " + button.websocketMessage );
                } else {
                    // TODO try reconnect
                    colorout.log("error", "[WEBSOCKET-Connection] WEBSOCKET not connected");
                }
                break;
            default:
                colorout.log("error", "[Core] Unknown action: " + button.action);
        }
    } else {
        colorout.log("debug", "[Core] Button disabled. Won't fire action");
    }
}

function getButtonIndex(btnFunction) {
    let i;
    for (i = 0; i < conf.buttons.length; i++) {
        if (conf.buttons[i].name == btnFunction) return i;
    }
    return -1;
}

init();
