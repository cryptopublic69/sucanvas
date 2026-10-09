import ReactDOM from "react-dom/client";
import "@xyflow/react/dist/style.css";
import App from "./App";

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
if (import.meta.env.MODE === "web") {
  void import("./web/WebRoot").then(({ default: WebRoot }) => root.render(<WebRoot />));
} else {
  root.render(<App />);
}
