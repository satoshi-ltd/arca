import "./src/runtime";
import React from "react";
import { registerRootComponent } from "expo";
import App from "./src/App";
import { ErrorBoundary } from "./src/ErrorBoundary";
registerRootComponent(() =>
  React.createElement(ErrorBoundary, null, React.createElement(App)),
);
