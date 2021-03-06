var PORT = 3478;
var HOST = '216.93.246.18';

const net = require('net');
const debug = require('debug')('main');

const ExposePort = require('./lib/ExposePort');
const ProxyServer = require('./lib/ProxyPortServer');

const Stun = require('./lib/stunclient');
const Protocol = require('./lib/proto');

const Common = require('./lib/Common');
const getRand = Common.getRand;

const argv = require('minimist')(process.argv.slice(2), {
  alias: {
    h: 'help',
    p: 'port',
    e: 'expose',
    c: 'connect'
  },
  default: {
    p: 7007
  },
  '--': true
});

if (argv.h || !argv._.length) {
  console.log('-h or --help to help\n-p or --port to set up server port\n-e or --expose [portnumber]\n-c or --connect [port]');
  process.exit(1);
}


var App = function () {
  var self = this;
  this.ids = [];
  this.ip = [];
  this.clients = {};
  this.stun = new Stun(HOST, PORT);
  this.proto = new Protocol();
  this.proto.on('packet', this.stun.send.bind(this.stun));

  this.stun.on('connected', this.onConnected.bind(this));
  this.stun.on('disconnected', function () {
    this.stun.close();
  });

  this.commandSocket = new net.Socket();
  this.commandSocket.on('data', function (data) {
    debug('commandSocket: Received: ' + data.length);
    var type = data[0];
    var sip1, sip2, sip3, sip4, sport;
    switch (type) {
    case 2:
      sip1 = data[1];
      sip2 = data[2];
      sip3 = data[3];
      sip4 = data[4];
      sport = data.readUInt16BE(5);
      var newip = `${sip1}.${sip2}.${sip3}.${sip4}`;
      self.stun.setClient(newip, sport);
      break;
    case 3:
      var count = (data.length - 1) / 3;
      for (var i = 0; i < count; ++i) {
        var id = data.readUInt16BE(2 + (i * 3));
        if (id !== ourId)
          self.ids.push(id);
      }
      if (self.ids.length) {
        self.stun.getIp().then((ip) => {
          self.ip = ip;
          self.sendIp();
        });
      }
      break;
    default:
    }
  });

  this.commandSocket.on('close', function () {
    debug('Connection closed');
  });
  this.commandSocket.connect(argv.p, argv._[0], () => {
    console.log('Connected');
    var buff = new Buffer(3);
    buff[0] = 0; //comand register
    // new name
    buff[1] = 0; // ok first is 0
    buff[2] = getRand();
    ourId = buff.readUInt16BE(1);
    this.commandSocket.write(buff);
  });

};

App.prototype.onConnected = function () {
  debug('Stun: Connected');
  if (argv.c) {
    //this.connect();
    this.outboundConnection = new ProxyServer(argv.c);

  } //end of c
  if (argv.e) {
    this.outboundConnection = new ExposePort(argv.e);
    //this.expose();
  }
  this.stun.on('data', this.proto.packet.bind(this.proto));
  this.proto.on('data', this.outboundConnection.onData.bind(this.outboundConnection));
  this.outboundConnection.on('data', this.proto.rawData.bind(this.proto));

};

App.prototype.connect = function () {
  var self = this;
  self.exposeServer = net.createServer((c) => {
    var id = getRand();
    var idMessage = new Buffer(2);
    idMessage[0] = 0x12; // id
    idMessage[1] = id;
    self.proto.rawData(idMessage);
    self.clients[id] = c;
    console.log('client connected');
    c.on('data', (data) => {
      var size = data.length + 2; // 1 byte type + 1 byte client id
      var message = new Buffer(size);
      data.copy(message, 2, 0);
      message[0] = 0x11; //data transfer
      message[1] = id;
      console.log(data.toString(), data.length);
      console.log(data, data.length);
      console.log(message);
      console.log(message.toString(), message.length);
      self.proto.rawData(message);
    });
    c.on('end', () => {
      if (self.clients[id]) {
        delete self.clients[id];
      }
      console.log('client disconnected');
    });
  });
  self.proto.on('data', (data) => {
    /*if (data.length < 2 || data[0] !== 0x11 || !self.clients[data[1]]) {
      return;
    }*/
    var out = new Buffer(data.length - 2);
    data.copy(out, 0, 2);
    self.clients[data[1]].write(out);
  });

  self.exposeServer.on('error', (err) => {
    throw err;
  });
  self.exposeServer.listen(argv.c, () => {
    console.log('proxy server bound on port ' + argv.c);
  });
};

App.prototype.expose = function () {
  var self = this;
  self.exposeSockets = {};
  self.buff = {};
  self.stun.on('data', (data) => {
    self.proto.packet(data);
  });
  self.proto.on('data', (data) => {
    if (data[0] == 0x12) {
      socket = new net.Socket();
      var id = data[1];
      self.exposeSockets[id] = socket;
      socket.on('data', (data) => {
        console.log('onData ' + data);
        var size = data.length + 2; // 1 byte type + 1 byte client id
        var message = new Buffer(size);
        data.copy(message, 2, 0);
        message[0] = 0x11; //data transfer
        message[1] = id;
        self.proto.rawData(message);
      });
      socket.on('end', function () {
        console.log('end');
        delete self.exposeSockets[id];
      });
      socket.connect(argv.e, 'localhost', () => {
        console.log('up connect id' + id);
        if (self.buff[data[1]]) {
          self.buff[data[1]].forEach((out) => {
            console.log('send data' + out);
            socket.write(out);
          });
        }
      });
    }
    if (data[0] == 0x11) {
      var out = new Buffer(data.length - 2);
      data.copy(out, 0, 2);
      if (!self.exposeSockets[data[1]]) {
        console.error('no socket');
        if (!self.buff[data[1]])
          self.buff[data[1]] = [];
        self.buff[data[1]].push(out);
        return;
      }
      self.exposeSockets[data[1]].write(out);
    }
  });
};

App.prototype.sendIp = function () {
  this.ids.forEach((Id) => {
    var buff = new Buffer(10);
    buff[0] = 0x02;
    buff.writeUInt16BE(Id, 1); //id
    buff[3] = 0x02;
    //ip
    buff[5] = this.ip[1];
    buff[4] = this.ip[0];
    buff[6] = this.ip[2];
    buff[7] = this.ip[3];
    //port
    buff.writeUInt16BE(this.ip[4], 8);
    this.commandSocket.write(buff);
  });
};

var app = new App();
