import express from "express";
import cors from "cors";

export const app = express();
app.use(express.json());
app.use(cors({ origin: true }));
app.use((req, _res, next) => {
  let timestamp = new Date().toISOString();
  console.log(`${timestamp} ${req.method} ${req.path}`);
  next();
});
