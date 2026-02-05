import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";

window.addEventListener("error", (e) => console.error("window.error", e.error || e.message));
window.addEventListener("unhandledrejection", (e) => console.error("unhandledrejection", e.reason));

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
