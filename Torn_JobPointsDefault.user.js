// ==UserScript==
// @name         Torn Job Points Default Setter
// @namespace    https://www.torn.com/
// @version      1.2.0
// @description  Sets a custom default Job Point spend amount for all job specials in Torn.
// @author       ShavedW00kie
// @homepageURL  https://github.com/ShavedW00kie
// @downloadURL  
// @updateURL    
// @match        https://www.torn.com/jobs.php*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// ==/UserScript==

(function() {
    "use strict";

    /* -----------------------------
       Storage Wrapper
    ----------------------------- */
    const Storage = {
        get(key, def) {
            try { return typeof GM_getValue === "function" ? GM_getValue(key, def) : JSON.parse(localStorage.getItem(key)) ?? def; }
            catch { return def; }
        },
        set(key, val) {
            try { typeof GM_setValue === "function" ? GM_setValue(key, val) : localStorage.setItem(key, JSON.stringify(val)); }
            catch {}
        }
    };

    const SETTINGS_KEY = "tjp_default_points";
    const DEFAULT_POINTS = Storage.get(SETTINGS_KEY, 10);

    /* -----------------------------
       Inject Settings Link
    ----------------------------- */
    function injectSettingsLink() {
        const header = document.querySelector(".content-title, #top-page-links, .title-black");
        if (!header) return;

        const link = document.createElement("a");
        link.textContent = "JP Settings";
        link.style.marginLeft = "12px";
        link.style.cursor = "pointer";
        link.style.fontWeight = "bold";
        link.style.color = "#4a89dc";

        link.addEventListener("click", openSettingsPanel);

        header.appendChild(link);
    }

    /* -----------------------------
       Settings Panel UI
    ----------------------------- */
    GM_addStyle(`
        #tjp-settings-panel {
            position: fixed;
            top: 120px;
            right: 40px;
            width: 260px;
            background: #222;
            color: #eee;
            border: 2px solid #555;
            padding: 15px;
            z-index: 99999;
            border-radius: 6px;
            display: none;
        }
        #tjp-settings-panel input {
            width: 80px;
            padding: 4px;
            margin-top: 8px;
        }
        #tjp-settings-panel button {
            margin-top: 10px;
            padding: 6px 10px;
            cursor: pointer;
        }
    `);

    function openSettingsPanel() {
        let panel = document.querySelector("#tjp-settings-panel");
        if (!panel) {
            panel = document.createElement("div");
            panel.id = "tjp-settings-panel";
            panel.innerHTML = `
                <h3 style="margin-top:0;">Job Points Default</h3>
                <label>Default JP Spend:</label><br>
                <input id="tjp-input" type="number" min="1" value="${DEFAULT_POINTS}">
                <br>
                <button id="tjp-save">Save</button>
                <button id="tjp-close">Close</button>
            `;
            document.body.appendChild(panel);

            panel.querySelector("#tjp-save").onclick = () => {
                const val = parseInt(panel.querySelector("#tjp-input").value, 10);
                if (!isNaN(val) && val > 0) {
                    Storage.set(SETTINGS_KEY, val);
                    alert("Saved! Default JP spend set to " + val);
                }
            };

            panel.querySelector("#tjp-close").onclick = () => {
                panel.style.display = "none";
            };
        }
        panel.style.display = "block";
    }

    /* -----------------------------
       Override Job Point Default
    ----------------------------- */
    function overrideJPDefault() {
        const observer = new MutationObserver(() => {
            const input = document.querySelector("input[name='jobPoints'], #jobPoints, input.job-points");
            if (input) {
                const val = Storage.get(SETTINGS_KEY, DEFAULT_POINTS);
                input.value = val;
                input.dispatchEvent(new Event("input", { bubbles: true }));
            }
        });

        observer.observe(document.body, { childList: true, subtree: true });
    }

    /* -----------------------------
       Init
    ----------------------------- */
    function init() {
        injectSettingsLink();
        overrideJPDefault();
    }

    init();
})();
