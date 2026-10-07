import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { WalletProvider } from "./lib/wallet.jsx";
import { ModeProvider } from "./lib/mode.jsx";
import App from "./App.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <BrowserRouter>
      <ModeProvider>
        <WalletProvider>
          <App />
        </WalletProvider>
      </ModeProvider>
    </BrowserRouter>
  </StrictMode>,
);
