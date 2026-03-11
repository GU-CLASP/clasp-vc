import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";

window.addEventListener("error", (e) => console.error("window.error", e.error || e.message));
window.addEventListener("unhandledrejection", (e) => console.error("unhandledrejection", e.reason));

const isRecordingRoute = window.location.pathname.startsWith("/recording");
const app = isRecordingRoute ? <App /> : (
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

ReactDOM.createRoot(document.getElementById("root")).render(app);
