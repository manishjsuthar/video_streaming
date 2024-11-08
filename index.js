import express from "express";
import https from "httpolyglot";
import fs from "fs";
import { Server } from "socket.io";
import mediasoup from "mediasoup";
import * as mongoose from "mongoose";
import cors from "cors";
const app = express();
import ChatPeer from "./models/ChatPeer.js";

// SSL cert for HTTPS access
const options = {
  key: fs.readFileSync("./server/ssl/key.pem", "utf-8"),
  cert: fs.readFileSync("./server/ssl/cert.pem", "utf-8"),
};

// Connect to MongoDB
const mongoURI = "mongodb://admin:Winter%402O24@3.7.95.4:27017/newstagingdb";
mongoose
  .connect(mongoURI, {})
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.log(err));

app.get("/", (req, res) => {
  res.status(201).send("hhello");
});

const httpsServer = https.createServer(options, app);

const io = new Server(httpsServer, {
  cors: {
    origin: "*",
  },
});

httpsServer.listen(7100, () => {
  console.log("listening on port: " + 7100);
});

// socket.io namespace (could represent a room?)
const connections = io.of("/mediasoup");
const corsOptions = {
  origin: "*",
  methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
  credentials: true, // Allow cookies with cross-origin requests
};

// Enable CORS with the configured options
app.use(cors(corsOptions));
/**
 * Worker
 * |-> Router(s)
 *     |-> Producer Transport(s)
 *         |-> Producer
 *     |-> Consumer Transport(s)
 *         |-> Consumer
 **/
let worker;
let rooms = {};
let transports = [];
let producers = [];
let consumers = [];

const createWorker = async () => {
  worker = await mediasoup.createWorker({
    rtcMinPort: 11000,
    rtcMaxPort: 12000,
  });
  console.log(`worker pid ${worker.pid}`);

  worker.on("died", (error) => {
    console.error("mediasoup worker has died");
    setTimeout(() => process.exit(1), 2000);
  });

  return worker;
};

// We create a Worker as soon as our application starts
worker = createWorker();

const mediaCodecs = [
  {
    kind: "audio",
    mimeType: "audio/opus",
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    parameters: {
      "x-google-start-bitrate": 1000,
    },
  },
];

connections.on("connection", async (socket) => {
  console.log("socketId: ", socket.id);
  socket.emit("connection-success", {
    socketId: socket.id,
  });

  const removeItems = (items, socketId, type) => {
    items.forEach((item) => {
      if (item.socketId === socketId) {
        item[type].close();
      }
    });
    items = items.filter((item) => item.socketId !== socketId);

    return items;
  };

  socket.on("disconnect", async () => {
    console.log("peer disconnected");
    consumers = removeItems(consumers, socket.id, "consumer");
    producers = removeItems(producers, socket.id, "producer");
    transports = removeItems(transports, socket.id, "transport");

    await ChatPeer.updateOne(
      { socketId: socket.id },
      {
        $set: {
          isActive: false,
        },
      }
    );
  });

  socket.on("joinRoom", async ({ roomName, role, name, id }, callback) => {
    // create Router if it does not exist
    const router1 = await createRoom(roomName, id);

    console.log("router1 ", router1);

    const peerDataEntity = await ChatPeer.create({
      socketId: socket.id,
      roomName,
      transports: [],
      producers: [],
      consumers: [],
      isActive: true,
      peerDetails: {
        name: name,
        id,
        isAdmin: role != "student",
      },
    });

    await peerDataEntity.save();

    // get Router RTP Capabilities
    const rtpCapabilities = router1.rtpCapabilities;

    console.log("rtpCapabilities ", rtpCapabilities);

    // call callback from the client and send back the rtpCapabilities
    callback({ rtpCapabilities });
  });

  const createRoom = async (roomName, id) => {
    let router1;
    let peers = [];
    if (rooms[roomName]) {
      router1 = rooms[roomName].router;
    } else {
      router1 = await worker.createRouter({ mediaCodecs });
    }

    console.log(`Router ID: ${router1.id}`, peers.length);

    await ChatPeer.updateMany(
      { roomName: roomName, "peerDetails.id": id },
      {
        $set: {
          isActive: false,
        },
      }
    );

    rooms[roomName] = {
      router: router1,
    };

    return router1;
  };

  socket.on("createWebRtcTransport", async ({ consumer }, callback) => {
    // get Room Name from Peer's properties
    // const roomName = peers[socket.id].roomName;

    const { roomName } = await ChatPeer.findOne({ socketId: socket.id });

    // get Router (Room) object this peer is in based on RoomName
    const router = rooms[roomName].router;

    createWebRtcTransport(router).then(
      (transport) => {
        callback({
          params: {
            id: transport["id"],
            iceParameters: transport["iceParameters"],
            iceCandidates: transport["iceCandidates"],
            dtlsParameters: transport["dtlsParameters"],
          },
        });

        // add transport to Peer's properties
        addTransport(transport, roomName, consumer);
      },
      (error) => {
        console.log(error);
      }
    );
  });

  const addTransport = async (transport, roomName, consumer) => {
    transports = [
      ...transports,
      { socketId: socket.id, transport, roomName, consumer },
    ];

    // peers[socket.id] = {
    //   ...peers[socket.id],
    //   transports: [...peers[socket.id].transports, transport.id],
    // };

    await ChatPeer.updateOne(
      { socketId: socket.id },
      {
        $addToSet: {
          transports: {
            socketId: socket.id,
            id: transport.id,
            isConsumerTransport: consumer,
          },
        },
      }
    );
  };

  const addProducer = async (producer, roomName, kind) => {
    producers = [...producers, { socketId: socket.id, producer, roomName }];

    // peers[socket.id] = {
    //   ...peers[socket.id],
    //   producers: [...peers[socket.id].producers, producer.id],
    // };

    await ChatPeer.updateOne(
      { socketId: socket.id },
      {
        $addToSet: {
          producers: { socketId: socket.id, id: producer.id, kind },
        },
      }
    );
  };

  const addConsumer = async (consumer, roomName) => {
    // add the consumer to the consumers list
    consumers = [...consumers, { socketId: socket.id, consumer, roomName }];

    // add the consumer id to the peers list
    // peers[socket.id] = {
    //   ...peers[socket.id],
    //   consumers: [...peers[socket.id].consumers, consumer.id],
    // };

    await ChatPeer.updateOne(
      { socketId: socket.id },
      {
        $addToSet: {
          consumers: {
            id: consumer.id,
            kind: consumer.kind,
            socketId: socket.id,
          },
        },
      }
    );
  };

  socket.on("getProducers", async (callback) => {
    //return all producer transports
    // const { roomName } = peers[socket.id];
    const { roomName } = await ChatPeer.findOne({ socketId: socket.id });

    // if (!peers) return callback(producerList);

    let producerList = [];
    producers.forEach((producerData) => {
      if (
        producerData.socketId !== socket.id &&
        producerData.roomName === roomName
      ) {
        producerList = [...producerList, producerData.producer.id];
      }
    });

    // return the producer list back to the client
    callback(producerList);
  });

  const informConsumers = (roomName, socketId, id) => {
    console.log(`just joined, id ${id} ${roomName}, ${socketId}`);

    // let all consumers to consume this producer
    producers.forEach((producerData) => {
      if (
        producerData.socketId !== socketId &&
        producerData.roomName === roomName
      ) {
        // const producerSocketId = peers[producerData.socketId].socketId;
        const producerSocket = connections.sockets.get(producerData.socketId);

        // use socket to send producer id to produce
        producerSocket.emit("new-producer", { producerId: id });
      }
    });
  };

  const getTransport = (socketId) => {
    const [producerTransport] = transports.filter(
      (transport) => transport.socketId === socketId && !transport.consumer
    );
    return producerTransport.transport;
  };

  // see client's socket.emit('transport-connect', ...)
  socket.on("transport-connect", ({ dtlsParameters }) => {
    console.log("DTLS PARAMS... ", { dtlsParameters });

    if (
      !getTransport(socket.id).connectionState ||
      getTransport(socket.id).connectionState === "new"
    ) {
      getTransport(socket.id).connect({ dtlsParameters });
    }
  });

  // see client's socket.emit('transport-produce', ...)
  socket.on(
    "transport-produce",
    async ({ kind, rtpParameters, appData }, callback) => {
      // call produce based on the prameters from the client
      const producer = await getTransport(socket.id).produce({
        kind,
        rtpParameters,
      });

      // await producer.pause();

      // add producer to the producers array
      const { roomName } = await ChatPeer.findOne({ socketId: socket.id });

      // const { roomName } = peers[socket.id];

      addProducer(producer, roomName, kind);

      informConsumers(roomName, socket.id, producer.id);

      producer.on("transportclose", () => {
        console.log("transport for this producer closed ");
        producer.close();
      });

      // Send back to the client the Producer's id
      callback({
        id: producer.id,
        producersExist: producers.length > 1 ? true : false,
      });
    }
  );

  socket.on("resumeProducerStream", async ({ socketId, kind }, callback) => {
    // const producer = producers.find((prod) => prod.producer.id === producerId);

    const producer = producers.find(
      (producer) =>
        producer.socketId === socketId && producer.producer.kind === kind
    );

    if (producer) {
      await producer.producer.resume();
      callback({ success: true });
    } else {
      callback({ success: false, error: "Producer not found" });
    }
  });

  // Handle consumer disconnecting and pausing producers again
  socket.on("pauseProducerStream", async ({ socketId, kind }, callback) => {
    // const producer = producers.find((prod) => prod.producer.id === producerId);
    const producer = producers.find(
      (producer) =>
        producer.socketId === socketId && producer.producer.kind === kind
    );

    if (producer) {
      await producer.producer.pause();
      callback({ success: true });
    } else {
      callback({ success: false, error: "Producer not found" });
    }
  });

  // see client's socket.emit('transport-recv-connect', ...)
  socket.on(
    "transport-recv-connect",
    async ({ dtlsParameters, serverConsumerTransportId }) => {
      console.log(`DTLS PARAMS: ${dtlsParameters}`);
      const consumerTransport = transports.find(
        (transportData) =>
          transportData.consumer &&
          transportData.transport.id == serverConsumerTransportId
      ).transport;
      await consumerTransport.connect({ dtlsParameters });
    }
  );

  socket.on(
    "consume",
    async (
      { rtpCapabilities, remoteProducerId, serverConsumerTransportId },
      callback
    ) => {
      try {
        // const { roomName } = peers[socket.id];

        const { roomName } = await ChatPeer.findOne({ socketId: socket.id });
        if (!roomName) return callback({});

        const router = rooms[roomName].router;

        let consumerTransport = transports.find(
          (transportData) =>
            transportData.consumer &&
            transportData.transport.id == serverConsumerTransportId
        ).transport;

        // check if the router can consume the specified producer
        if (
          router.canConsume({
            producerId: remoteProducerId,
            rtpCapabilities,
          })
        ) {
          // transport can now consume and return a consumer
          const consumer = await consumerTransport.consume({
            producerId: remoteProducerId,
            rtpCapabilities,
            paused: true,
          });

          consumer.on("transportclose", () => {
            console.log("transport close from consumer");
          });

          consumer.on("producerclose", () => {
            console.log("producer of consumer closed");
            socket.emit("producer-closed", { remoteProducerId });

            consumerTransport.close([]);
            transports = transports.filter(
              (transportData) =>
                transportData.transport.id !== consumerTransport.id
            );
            consumer.close();
            consumers = consumers.filter(
              (consumerData) => consumerData.consumer.id !== consumer.id
            );
          });

          addConsumer(consumer, roomName);

          // from the consumer extract the following params
          // to send back to the Client
          const params = {
            id: consumer.id,
            producerId: remoteProducerId,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters,
            serverConsumerId: consumer.id,
          };

          // send the parameters to the client
          callback({ params });
        }
      } catch (error) {
        console.log(error.message);
        callback({
          params: {
            error: error,
          },
        });
      }
    }
  );

  socket.on("consumer-resume", async ({ serverConsumerId }) => {
    console.log("consumer resume");
    const { consumer } = consumers.find(
      (consumerData) => consumerData.consumer.id === serverConsumerId
    );
    await consumer.resume();
  });
});

const createWebRtcTransport = async (router) => {
  return new Promise(async (resolve, reject) => {
    try {
      // https://mediasoup.org/documentation/v3/mediasoup/api/#WebRtcTransportOptions
      const webRtcTransport_options = {
        listenIps: [
          {
            ip: "0.0.0.0", // replace with relevant IP address
            announcedIp: "127.0.0.1",
          },
        ],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
      };

      // https://mediasoup.org/documentation/v3/mediasoup/api/#router-createWebRtcTransport
      let transport = await router.createWebRtcTransport(
        webRtcTransport_options
      );
      console.log(`transport id: ${transport.id}`);

      transport.on("dtlsstatechange", (dtlsState) => {
        if (dtlsState === "closed") {
          transport.close();
        }
      });

      transport.on("close", () => {
        console.log("transport closed");
      });

      resolve(transport);
    } catch (error) {
      reject(error);
    }
  });
};
