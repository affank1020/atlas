import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Provider } from 'react-redux';
import { store } from './store';

import { Bootstrap } from './AppBootstrap';
import "./tokens.css";
import "./styles.css";
import "./ask-atlas.css";
import "./shell.css";
import './bootstrap.css';

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <Provider store={store}><Bootstrap /></Provider>
    </StrictMode>,
);
