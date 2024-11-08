import mongoose from "mongoose";

const peerSchema = new mongoose.Schema({
  socketId: { type: String, required: true, unique: true },
  roomName: { type: String, required: true },
  transports: [{ id: String, isConsumerTransport: Boolean }],
  producers: [{ id: String, socketId: String, kind: String }],
  consumers: [{ id: String, socketId: String, kind: String }],
  isActive: { type: Boolean, default: true },
  peerDetails: {
    name: String,
    id: String,
    isAdmin: Boolean,
  },
});

export default mongoose.model("mediapeers", peerSchema);
