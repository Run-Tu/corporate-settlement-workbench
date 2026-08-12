import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles/app.css";

const app = document.querySelector("#app");

if (!app) {
  throw new Error("Cannot find #app mount node.");
}

createRoot(app).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
