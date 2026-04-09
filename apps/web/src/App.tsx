import { useState, useEffect } from "react";
import reactLogo from "./assets/react.svg";
import viteLogo from "./assets/vite.svg";
import heroImg from "./assets/hero.png";
import "./App.css";

function App() {
  const [data, setData] = useState(null);

  useEffect(() => {
    fetch("/home")
      .then((res) => res.json())
      .then((json) => setData(json));
  }, []);

  return (
    <>
      <section id="center">
        <div>
          <h1>Get started</h1>
          <p>
            Edit <code>src/App.tsx</code> and save to test <code>HMR</code>
          </p>
        </div>
      </section>

      <section id="center">
        <div>
          <h1>Response</h1>
          <pre>{JSON.stringify(data, null, 2)}</pre>
        </div>
      </section>
    </>
  );
}

export default App;
