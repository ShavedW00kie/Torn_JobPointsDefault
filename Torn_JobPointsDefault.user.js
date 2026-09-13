// ==UserScript==
// @name         Torn Job Points Default Setter
// @namespace    https://github.com/ShavedW00kie/
// @version      1.2.1
// @description  Sets a saved default on detected job-point inputs without overwriting manual edits. Includes settings and diagnostic logs.
// @author       ShavedW00kie (Torn: ThaWookie [2954173] )
// @license      BSD-3-Clause
// @homepageURL  https://github.com/ShavedW00kie
// @match        https://www.torn.com/jobs.php*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_info
// @run-at       document-end
// @noframes
// ==/UserScript==

(function (GM_info) {
    "use strict";

    // Full BSD-3-Clause notice is included with the embedded module below
    // and applies to this entire userscript.
    const MyDebug = initializeModularDebugger(GM_info.script.name);
    const KEY = "tjp_default_points"; // Preserve the original saved preference.
    const SELECTOR = "input[name='jobPoints'], input#jobPoints, input.job-points";
    const states = new WeakMap();
    const writing = new WeakSet();
    let defaultPoints = 10;
    let backend = "local";
    let panel, settingsButton, settingsInput, status, saveButton;

    function validPoints(value) {
        if (typeof value !== "number" && typeof value !== "string") return null;
        const text = String(value).trim();
        if (!/^\d+$/.test(text)) return null;
        const n = Number(text);
        return Number.isSafeInteger(n) && n > 0 ? n : null;
    }

    async function loadSettings() {
        // Use one consistent backend; never silently fall back after a failed write.
        if (typeof GM_getValue === "function" && typeof GM_setValue === "function") {
            backend = "gm";
        }
        try {
            const raw = backend === "gm"
                ? await GM_getValue(KEY, 10)
                : JSON.parse(localStorage.getItem(KEY) ?? "10");
            defaultPoints = validPoints(raw) ?? 10;
            if (validPoints(raw) === null) {
                MyDebug.log({ event: "invalid-saved-setting", fallback: 10 }, "WARN");
            }
        } catch (error) {
            MyDebug.log({ event: "settings-read-failed", message: String(error) }, "ERROR");
        }
    }

    function isTarget(input) {
        return input instanceof HTMLInputElement && input.matches(SELECTOR)
            && !input.closest("#tjp-settings-panel")
            && ["number", "text", "tel"].includes(input.type);
    }

    function numericAttribute(input, name) {
        const text = input.getAttribute(name);
        if (text === null || text.trim() === "") return null;
        const n = Number(text);
        return Number.isFinite(n) ? n : null;
    }

    function constrainedValue(input) {
        const min = numericAttribute(input, "min");
        const max = numericAttribute(input, "max");
        const low = Math.max(1, Math.ceil(min ?? 1));
        const high = Math.min(Number.MAX_SAFE_INTEGER, Math.floor(max ?? Number.MAX_SAFE_INTEGER));
        if (low > high) return null;
        let value = Math.max(low, Math.min(defaultPoints, high));
        // Integer job points only. Unsupported fractional steps fail closed.
        const rawStep = input.getAttribute("step");
        const step = rawStep === "any" ? 1 : numericAttribute(input, "step") ?? 1;
        if (!Number.isSafeInteger(step) || step < 1) return null;
        const base = min ?? numericAttribute(input, "value") ?? 0;
        if (!Number.isSafeInteger(base)) return null;
        const first = low + ((base - low) % step + step) % step;
        const last = high - ((high - base) % step + step) % step;
        if (first > last) return null;
        value -= ((value - base) % step + step) % step;
        return Math.max(first, Math.min(value, last));
    }

    function initializeInput(input) {
        if (!isTarget(input) || !input.isConnected) return;
        let state = states.get(input);
        if (!state) {
            state = { touched: false, applied: false, lastValue: null };
            states.set(input, state);
        }
        if (state.touched || state.applied || input.matches(":disabled") || input.readOnly) return;
        if (document.activeElement === input) {
            state.touched = true;
            return;
        }
        const value = constrainedValue(input);
        if (value === null) return;
        // Mark before dispatch: handlers may synchronously mutate Torn's DOM.
        state.applied = true;
        state.lastValue = String(value);
        if (input.value === state.lastValue) return;
        try {
            writing.add(input);
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
            setter.call(input, state.lastValue);
            input.dispatchEvent(new Event("input", { bubbles: true }));
            MyDebug.log({ event: "default-applied", requested: defaultPoints, applied: value });
        } catch (error) {
            MyDebug.log({ event: "input-update-failed", message: String(error) }, "ERROR");
        } finally {
            writing.delete(input);
        }
    }

    function scan(root) {
        if (!(root instanceof Element) && root !== document) return;
        if (root instanceof Element && root.closest("#tjp-settings-panel, [id^='us-debug-']")) return;
        if (root instanceof Element && root.matches(SELECTOR)) initializeInput(root);
        root.querySelectorAll(SELECTOR).forEach(initializeInput);
    }

    function markEdited(event) {
        const input = event.target;
        if (!isTarget(input) || writing.has(input)) return;
        const state = states.get(input) ?? { applied: false, lastValue: null };
        state.touched = true;
        states.set(input, state);
    }

    function ensureSettingsButton() {
        const header = document.querySelector(".content-title, #top-page-links, .title-black");
        const host = header ?? document.body;
        if (settingsButton.classList.contains("tjp-floating") !== !header) {
            settingsButton.classList.toggle("tjp-floating", !header);
        }
        if (settingsButton.parentNode !== host) host.appendChild(settingsButton);
    }

    function closeSettings() {
        panel.hidden = true;
        settingsButton.setAttribute("aria-expanded", "false");
        settingsButton.focus();
    }

    function openSettings() {
        if (!panel.isConnected) document.body.appendChild(panel);
        if (panel.hidden) {
            settingsInput.value = String(defaultPoints);
            status.textContent = "";
        }
        panel.hidden = false;
        settingsButton.setAttribute("aria-expanded", "true");
        settingsInput.focus();
    }

    function buildSettings() {
        const style = document.createElement("style");
        style.textContent = `
            #tjp-settings-button, #tjp-settings-panel button {
                font:inherit; min-height:44px; padding:8px 12px; cursor:pointer;
                border:1px solid #687381; border-radius:6px; background:#26364a;
                color:#fff; touch-action:manipulation;
            }
            #tjp-settings-button {margin-left:12px; font-weight:bold;}
            #tjp-settings-button.tjp-floating {position:fixed; bottom:16px; right:16px; z-index:99998;}
            #tjp-settings-panel {
                box-sizing:border-box; position:fixed; top:70px; right:12px;
                width:330px; max-width:calc(100vw - 24px); max-height:calc(100vh - 90px);
                overflow:auto; padding:16px; background:#222; color:#eee;
                border:1px solid #697482; border-radius:10px; z-index:99999;
                box-shadow:0 8px 28px #0008; font:14px/1.5 Arial,sans-serif;
            }
            #tjp-settings-panel[hidden] {display:none!important;}
            #tjp-settings-panel h3 {margin:0 0 12px; color:#fff;}
            #tjp-settings-panel input {box-sizing:border-box; width:100%; min-height:44px;
                margin:8px 0; padding:8px; font-size:16px; background:#fff; color:#111;}
            #tjp-settings-panel .tjp-actions {display:flex; flex-wrap:wrap; gap:8px; margin-top:12px;}
            #tjp-settings-panel p {margin:8px 0;}
            #tjp-settings-panel button:focus-visible, #tjp-settings-button:focus-visible {
                outline:3px solid #84bcff; outline-offset:2px;
            }
            @keyframes us-debug-status-reset {from {opacity:.75} to {opacity:1}}
            #tjp-settings-panel .us-debug-status-reset {animation:us-debug-status-reset 1.5s ease-in-out 1;}
        `;
        (document.head ?? document.body).appendChild(style);
        settingsButton = document.createElement("button");
        settingsButton.id = "tjp-settings-button";
        settingsButton.type = "button";
        settingsButton.textContent = "JP Settings";
        settingsButton.setAttribute("aria-controls", "tjp-settings-panel");
        settingsButton.setAttribute("aria-expanded", "false");
        settingsButton.addEventListener("click", openSettings);
        panel = document.createElement("section");
        panel.id = "tjp-settings-panel";
        panel.hidden = true;
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-labelledby", "tjp-title");
        // Static markup only; stored settings are assigned through .value.
        panel.innerHTML = `
            <h3 id="tjp-title">Job Points Default</h3>
            <form id="tjp-form" novalidate>
                <label for="tjp-input">Default JP spend</label>
                <input id="tjp-input" type="number" inputmode="numeric" min="1" step="1" required>
                <p>Prefills detected job-point fields. You can still change an amount before spending.</p>
                <p>Saving updates untouched fields and future fields. Declared limits are respected.</p>
                <div class="tjp-actions">
                    <button id="tjp-save" type="submit">Save</button>
                    <button id="tjp-close" type="button">Close</button>
                </div>
            </form>
            <p id="tjp-status" role="status" aria-live="polite"></p>
            <div class="tjp-actions">
                <button id="tjp-debug" type="button" aria-label="Toggle debug log">ðŸª²</button>
                <button id="tjp-copy" type="button">ðŸ“‹ Copy Logs to Clipboard</button>
            </div>`;
        settingsInput = panel.querySelector("#tjp-input");
        status = panel.querySelector("#tjp-status");
        saveButton = panel.querySelector("#tjp-save");
        panel.querySelector("#tjp-close").addEventListener("click", closeSettings);
        panel.querySelector("#tjp-debug").addEventListener("click", () => MyDebug.toggleView());
        panel.querySelector("#tjp-copy").addEventListener("click", function () { void MyDebug.copy(this); });
        panel.addEventListener("keydown", event => {
            if (event.key === "Escape") { event.stopPropagation(); closeSettings(); }
        });
        panel.querySelector("form").addEventListener("submit", async event => {
            event.preventDefault();
            if (saveButton.disabled) return;
            const value = validPoints(settingsInput.value);
            if (value === null) {
                status.textContent = "Enter a positive whole number within JavaScript's safe integer range.";
                settingsInput.focus();
                return;
            }
            saveButton.disabled = true;
            try {
                if (backend === "gm") await GM_setValue(KEY, value);
                else localStorage.setItem(KEY, JSON.stringify(value));
                defaultPoints = value;
                document.querySelectorAll(SELECTOR).forEach(input => {
                    const state = states.get(input);
                    if (state && !state.touched && input.value === state.lastValue) state.applied = false;
                    initializeInput(input);
                });
                status.textContent = `Saved! Default JP spend: ${value}.`;
                MyDebug.log({ event: "settings-saved", defaultPoints: value });
            } catch (error) {
                status.textContent = "Could not save. Check storage permissions and try again.";
                MyDebug.log({ event: "settings-save-failed", message: String(error) }, "ERROR");
            } finally {
                saveButton.disabled = false;
            }
        });
        document.body.appendChild(panel);
        ensureSettingsButton();
    }

    async function init() {
        // Capture edits even while an asynchronous storage shim is loading.
        document.addEventListener("input", markEdited, true);
        document.addEventListener("change", markEdited, true);
        await loadSettings();
        buildSettings();
        const observer = new MutationObserver(records => {
            for (const record of records) {
                if (record.type === "attributes") scan(record.target);
                else record.addedNodes.forEach(scan);
            }
            ensureSettingsButton();
        });
        observer.observe(document.body, {
            childList: true, subtree: true, attributes: true,
            attributeFilter: ["name", "id", "class", "type", "disabled", "readonly", "min", "max", "step"]
        });
        scan(document);
        MyDebug.log({ event: "initialized", version: "1.2.1", defaultPoints, storage: backend });
    }

    function start() {
        void init().catch(error => MyDebug.log({ event: "initialization-failed", message: String(error) }, "ERROR"));
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
    else start();

    // Supplied debugger v1.0.2, with the strict-mode syntax fix noted below.
/**
 * File: userscript-debugger-module.js
 * Version: 1.0.3 (embedded strict-mode syntax fix)
 * Advanced Modular Userscript Debugger Engine
 * Author: Github.com/ShavedW00kie/
 * Optimized for Desktop PC, Mobile Browsers, and TornPDA Native WebViews
 *
 * License: BSD-3-Clause
 *
 * Copyright (c) 2026 ShavedW00kie
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice,
 *    this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the documentation
 *    and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its
 *    contributors may be used to endorse or promote products derived from
 *    this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */

/**
 * initializeModularDebugger()
 *
 * Creates an isolated debugger instance for a userscript.
 *
 * Public API:
 *   MyDebug.log(message)
 *   MyDebug.info(message)
 *   MyDebug.warn(message)
 *   MyDebug.error(message)
 *   MyDebug.copy(buttonElement)
 *   MyDebug.toggleView()
 *   MyDebug.clear()
 *
 * Example:
 *
 * const MyDebug = initializeModularDebugger(GM_info.script.name);
 *
 * MyDebug.log("Script initialized.");
 * MyDebug.error("Something went wrong.");
 *
 * // Settings UI:
 * debugButton.onclick = () => MyDebug.toggleView();
 * copyButton.onclick = function () {
 *     MyDebug.copy(this);
 * };
 */
function initializeModularDebugger(scriptNamespace = "App") {
    // Strict mode is inherited from the enclosing IIFE.
    // A directive here is invalid with a default parameter.

    /* ============================================================
     * 1. INSTANCE ISOLATION
     * ============================================================ */

    const randomSuffix = (() => {
        try {
            if (
                typeof crypto !== "undefined" &&
                typeof crypto.randomUUID === "function"
            ) {
                return crypto.randomUUID().replace(/-/g, "");
            }
        } catch (_) {
            // Fall through to compatibility fallback.
        }

        return Math.random()
            .toString(36)
            .slice(2, 11) +
            Date.now().toString(36);
    })();

    const prefix = `us-debug-${randomSuffix}`;

    const CONTAINER_ID = `${prefix}-box`;
    const LOG_AREA_ID = `${prefix}-logs`;

    /* ============================================================
     * 2. MEMORY LIMITS
     * ============================================================ */

    /*
     * Clipboard-safe baseline.
     *
     * JavaScript strings are UTF-16. This limit is intentionally
     * character-based rather than byte-based because browser clipboard
     * implementations differ in their handling of Unicode.
     */
    const CLIPBOARD_MAX_CHARS = 10 * 1024 * 1024;

    /*
     * Reserve approximately 900 KiB of headroom.
     *
     * Effective maximum retained log buffer:
     * approximately 9.1 million characters.
     */
    const BUFFER_REDUCTION_MARGIN = 900 * 1024;

    const MAX_LOG_STRING_LENGTH =
        CLIPBOARD_MAX_CHARS - BUFFER_REDUCTION_MARGIN;

    /*
     * Never allow one pathological message to exceed the entire
     * configured buffer.
     */
    const MAX_SINGLE_LOG_LENGTH = MAX_LOG_STRING_LENGTH;

    /* ============================================================
     * 3. INTERNAL STATE
     * ============================================================ */

    const state = {
        logs: [],
        currentBufferLength: 0,

        domElements: {
            container: null,
            logArea: null
        },

        observer: null,
        observerAttached: false,

        destroyed: false
    };

    /* ============================================================
     * 4. DOM UTILITIES
     * ============================================================ */

    function getDocumentBody() {
        return document && document.body
            ? document.body
            : null;
    }

    function getExistingContainer() {
        return document.getElementById(CONTAINER_ID);
    }

    function isContainerAttached() {
        return Boolean(
            state.domElements.container &&
            state.domElements.container.isConnected
        );
    }

    function ensureObserver() {
        if (
            state.observerAttached ||
            typeof MutationObserver === "undefined"
        ) {
            return;
        }

        const body = getDocumentBody();

        if (!body) {
            return;
        }

        state.observer = new MutationObserver(() => {
            /*
             * Do not continuously recreate the UI.
             *
             * If the user intentionally hides the debugger, the
             * element still exists and therefore remains untouched.
             *
             * If Torn or another page lifecycle removes the element,
             * the internal references are invalidated so the next
             * toggleView() can recreate it safely.
             */
            if (
                state.domElements.container &&
                !state.domElements.container.isConnected
            ) {
                state.domElements.container = null;
                state.domElements.logArea = null;
            }
        });

        state.observer.observe(body, {
            childList: true,
            subtree: true
        });

        state.observerAttached = true;
    }

    function appendToBody(element) {
        const body = getDocumentBody();

        if (!body || !element) {
            return false;
        }

        body.appendChild(element);
        return true;
    }

    /* ============================================================
     * 5. SAFE SERIALIZATION
     * ============================================================ */

    function safeSerialize(value) {
        /*
         * Fast path for strings.
         */
        if (typeof value === "string") {
            return value;
        }

        /*
         * Primitive values.
         */
        if (
            value === null ||
            typeof value === "number" ||
            typeof value === "boolean" ||
            typeof value === "bigint"
        ) {
            try {
                return String(value);
            } catch (_) {
                return "[Unserializable Primitive]";
            }
        }

        if (typeof value === "undefined") {
            return "undefined";
        }

        if (typeof value === "symbol") {
            try {
                return value.toString();
            } catch (_) {
                return "[Symbol]";
            }
        }

        if (typeof value === "function") {
            try {
                return `[Function: ${value.name || "anonymous"}]`;
            } catch (_) {
                return "[Function]";
            }
        }

        /*
         * Error objects deserve special handling because
         * JSON.stringify(new Error()) normally returns "{}".
         */
        if (value instanceof Error) {
            const errorObject = {
                name: value.name,
                message: value.message,
                stack: value.stack
            };

            try {
                return JSON.stringify(errorObject);
            } catch (_) {
                return `${value.name || "Error"}: ${value.message || ""}`;
            }
        }

        /*
         * General objects.
         *
         * WeakSet prevents circular-reference crashes.
         */
        try {
            const seen = new WeakSet();

            const serialized = JSON.stringify(
                value,
                (key, nestedValue) => {
                    if (typeof nestedValue === "bigint") {
                        return `${nestedValue}n`;
                    }

                    if (typeof nestedValue === "undefined") {
                        return "[undefined]";
                    }

                    if (
                        typeof nestedValue === "object" &&
                        nestedValue !== null
                    ) {
                        if (seen.has(nestedValue)) {
                            return "[Circular]";
                        }

                        seen.add(nestedValue);
                    }

                    return nestedValue;
                }
            );

            if (typeof serialized === "string") {
                return serialized;
            }
        } catch (_) {
            // Fall through to String() fallback.
        }

        try {
            return String(value);
        } catch (_) {
            return "[Serialization Error]";
        }
    }

    /* ============================================================
     * 6. LOG ENTRY MANAGEMENT
     * ============================================================ */

    function truncateLogEntry(entry) {
        if (entry.length <= MAX_SINGLE_LOG_LENGTH) {
            return entry;
        }

        return (
            entry.slice(0, MAX_SINGLE_LOG_LENGTH - 40) +
            "\n...[LOG ENTRY TRUNCATED]..."
        );
    }

    function pruneBufferForEntry(entryLength) {
        while (
            state.logs.length > 0 &&
            state.currentBufferLength + entryLength >
                MAX_LOG_STRING_LENGTH
        ) {
            const removed = state.logs.shift();

            if (typeof removed === "string") {
                state.currentBufferLength -= removed.length + 1;
            }
        }

        /*
         * Defensive correction against any impossible negative state
         * caused by external mutation or future implementation changes.
         */
        if (state.currentBufferLength < 0) {
            state.currentBufferLength = 0;
        }
    }

    function renderLogs() {
        const logArea = state.domElements.logArea;

        if (!logArea || !logArea.isConnected) {
            return;
        }

        logArea.textContent = state.logs.join("\n");

        const container = state.domElements.container;

        if (container && container.isConnected) {
            container.scrollTop = container.scrollHeight;
        }
    }

    /* ============================================================
     * 7. PUBLIC LOGGING ENGINE
     * ============================================================ */

    function log(message, level = "INFO") {
        const time = new Date().toLocaleTimeString();

        let cleanMessage = safeSerialize(message);

        cleanMessage = truncateLogEntry(cleanMessage);

        const normalizedLevel =
            typeof level === "string"
                ? level.toUpperCase()
                : "INFO";

        let entry =
            `[${time}] [${normalizedLevel}] ${cleanMessage}`;

        entry = truncateLogEntry(entry);

        const entryLength = entry.length + 1;

        /*
         * If the entry is somehow still too large, do not store it.
         */
        if (entry.length > MAX_LOG_STRING_LENGTH) {
            return;
        }

        pruneBufferForEntry(entryLength);

        state.logs.push(entry);
        state.currentBufferLength += entryLength;

        renderLogs();
    }

    function info(message) {
        log(message, "INFO");
    }

    function warn(message) {
        log(message, "WARN");
    }

    function error(message) {
        log(message, "ERROR");
    }

    /* ============================================================
     * 8. CLEAR LOGS
     * ============================================================ */

    function clearLogs() {
        state.logs.length = 0;
        state.currentBufferLength = 0;

        renderLogs();
    }

    /* ============================================================
     * 9. COPY STATUS UI
     * ============================================================ */

    function setButtonStatus(button, text, statusClass = "") {
        if (!button) {
            return;
        }

        button.textContent = text;

        if (statusClass) {
            button.dataset.debugStatus = statusClass;
        } else {
            delete button.dataset.debugStatus;
        }
    }

    /*
     * Restore button state without using a timer.
     *
     * CSS animation provides the delay and animationend restores
     * the original label. This avoids setTimeout-based state handling.
     */
    function prepareStatusAnimation(button) {
        if (!button) {
            return;
        }

        if (button.dataset.debugStatusListener === "1") {
            return;
        }

        button.dataset.debugStatusListener = "1";

        button.addEventListener("animationend", (event) => {
            if (event.animationName !== "us-debug-status-reset") {
                return;
            }

            const originalText =
                button.dataset.debugOriginalText || "Copy Logs";

            button.textContent = originalText;

            delete button.dataset.debugStatus;
        });
    }

    function showCopyStatus(button, text, originalText = null) {
        if (!button) {
            return;
        }

        prepareStatusAnimation(button);

        if (originalText) {
            button.dataset.debugOriginalText = originalText;
        } else if (!button.dataset.debugOriginalText) {
            button.dataset.debugOriginalText =
                button.textContent || "Copy Logs";
        }

        button.classList.remove("us-debug-status-reset");

        /*
         * Force animation restart without a timing delay.
         */
        void button.offsetWidth;

        button.textContent = text;
        button.classList.add("us-debug-status-reset");
    }

    /* ============================================================
     * 10. CLIPBOARD ENGINE
     * ============================================================ */

    async function copyLogs(buttonElement = null) {
        const payload = state.logs.join("\n");

        if (!payload) {
            showCopyStatus(buttonElement, "Empty!");
            return false;
        }

        /*
         * Preferred modern clipboard implementation.
         */
        if (
            typeof navigator !== "undefined" &&
            navigator.clipboard &&
            typeof navigator.clipboard.writeText === "function"
        ) {
            try {
                await navigator.clipboard.writeText(payload);

                showCopyStatus(buttonElement, "Copied!");

                return true;
            } catch (_) {
                /*
                 * Continue into compatibility fallback.
                 */
            }
        }

        /*
         * Legacy compatibility path.
         *
         * Still useful for restricted userscript environments,
         * embedded WebViews, and older browser implementations.
         */
        const success = handleCopyFallback(payload);

        if (success) {
            showCopyStatus(buttonElement, "Copied!");
            return true;
        }

        showCopyStatus(buttonElement, "Failed!");
        return false;
    }

    function handleCopyFallback(textData) {
        try {
            const body = getDocumentBody();

            if (!body) {
                return false;
            }

            const textarea = document.createElement("textarea");

            textarea.value = textData;

            textarea.setAttribute("readonly", "");
            textarea.style.position = "fixed";
            textarea.style.top = "0";
            textarea.style.left = "0";
            textarea.style.width = "1px";
            textarea.style.height = "1px";
            textarea.style.padding = "0";
            textarea.style.border = "0";
            textarea.style.outline = "0";
            textarea.style.boxShadow = "none";
            textarea.style.background = "transparent";
            textarea.style.opacity = "0";

            body.appendChild(textarea);

            textarea.focus();
            textarea.select();

            /*
             * iOS/WebView compatibility.
             */
            try {
                textarea.setSelectionRange(
                    0,
                    textarea.value.length
                );
            } catch (_) {
                // Not supported in every environment.
            }

            let success = false;

            try {
                success = document.execCommand("copy");
            } catch (_) {
                success = false;
            }

            textarea.remove();

            return Boolean(success);
        } catch (copyError) {
            /*
             * Logging the failure is intentionally done without
             * console.error so the module never reintroduces the
             * native console logging that the architecture is
             * designed to replace.
             */
            error({
                operation: "clipboard-fallback",
                message:
                    copyError && copyError.message
                        ? copyError.message
                        : String(copyError)
            });

            return false;
        }
    }

    /* ============================================================
     * 11. DEBUGGER UI
     * ============================================================ */

    function injectStyles() {
        if (document.getElementById(`${prefix}-style`)) {
            return;
        }

        const styleNode = document.createElement("style");

        styleNode.id = `${prefix}-style`;

        styleNode.textContent = `
            @keyframes us-debug-status-reset {
                from {
                    opacity: 0.75;
                }
                to {
                    opacity: 1;
                }
            }

            #${CONTAINER_ID} .us-debug-status-reset {
                animation: us-debug-status-reset 1.5s ease-in-out 1;
            }
        `;

        const head = document.head;

        if (head) {
            head.appendChild(styleNode);
        } else {
            const body = getDocumentBody();

            if (body) {
                body.appendChild(styleNode);
            }
        }
    }

    function createDebuggerContainer() {
        const body = getDocumentBody();

        if (!body) {
            return null;
        }

        const existingContainer = getExistingContainer();

        if (existingContainer) {
            state.domElements.container = existingContainer;

            const existingLogArea =
                document.getElementById(LOG_AREA_ID);

            state.domElements.logArea = existingLogArea;

            renderLogs();

            return existingContainer;
        }

        injectStyles();

        const container = document.createElement("div");

        container.id = CONTAINER_ID;

        container.style.cssText = [
            "position:fixed",
            "bottom:12px",
            "right:12px",
            "width:calc(100% - 24px)",
            "max-width:420px",
            "height:280px",
            "background:#181818",
            "color:#00ff66",
            "font-family:monospace",
            "font-size:11px",
            "padding:12px",
            "z-index:2147483647",
            "border:1px solid #00ff66",
            "overflow-y:auto",
            "overflow-x:hidden",
            "box-shadow:0 4px 20px rgba(0,0,0,0.7)",
            "border-radius:4px",
            "box-sizing:border-box",
            "touch-action:pan-y"
        ].join(";");

        const header = document.createElement("div");

        header.style.cssText = [
            "display:flex",
            "justify-content:space-between",
            "align-items:center",
            "gap:8px",
            "margin-bottom:8px",
            "border-bottom:1px solid #333",
            "padding-bottom:5px",
            "user-select:none"
        ].join(";");

        const title = document.createElement("span");

        title.textContent =
            `DEBUG LOG [${String(scriptNamespace)}]`;

        title.style.cssText = [
            "font-weight:bold",
            "letter-spacing:0.5px",
            "overflow:hidden",
            "text-overflow:ellipsis",
            "white-space:nowrap"
        ].join(";");

        const buttonGroup = document.createElement("div");

        buttonGroup.style.cssText = [
            "display:flex",
            "gap:6px",
            "flex-shrink:0"
        ].join(";");

        const copyBtn = document.createElement("button");

        copyBtn.type = "button";
        copyBtn.textContent = "Copy";
        copyBtn.style.cssText = [
            "background:#2a2a2a",
            "color:#fff",
            "border:1px solid #444",
            "cursor:pointer",
            "padding:5px 8px",
            "font-size:10px",
            "border-radius:3px",
            "touch-action:manipulation"
        ].join(";");

        copyBtn.addEventListener("click", () => {
            void copyLogs(copyBtn);
        });

        const clearBtn = document.createElement("button");

        clearBtn.type = "button";
        clearBtn.textContent = "Clear";
        clearBtn.style.cssText = [
            "background:#2a2a2a",
            "color:#fff",
            "border:1px solid #444",
            "cursor:pointer",
            "padding:5px 8px",
            "font-size:10px",
            "border-radius:3px",
            "touch-action:manipulation"
        ].join(";");

        clearBtn.addEventListener("click", () => {
            clearLogs();
        });

        const closeBtn = document.createElement("button");

        closeBtn.type = "button";
        closeBtn.textContent = "Hide";
        closeBtn.style.cssText = [
            "background:#a82020",
            "color:#fff",
            "border:none",
            "cursor:pointer",
            "padding:5px 8px",
            "font-size:10px",
            "border-radius:3px",
            "touch-action:manipulation"
        ].join(";");

        closeBtn.addEventListener("click", () => {
            container.style.display = "none";
        });

        const logArea = document.createElement("div");

        logArea.id = LOG_AREA_ID;

        logArea.style.cssText = [
            "white-space:pre-wrap",
            "overflow-wrap:anywhere",
            "word-break:break-word",
            "font-family:monospace",
            "line-height:1.4",
            "user-select:text"
        ].join(";");

        buttonGroup.appendChild(copyBtn);
        buttonGroup.appendChild(clearBtn);
        buttonGroup.appendChild(closeBtn);

        header.appendChild(title);
        header.appendChild(buttonGroup);

        container.appendChild(header);
        container.appendChild(logArea);

        if (!appendToBody(container)) {
            return null;
        }

        state.domElements.container = container;
        state.domElements.logArea = logArea;

        renderLogs();

        return container;
    }

    /* ============================================================
     * 12. VIEW TOGGLE
     * ============================================================ */

    function toggleConsoleView() {
        const existingContainer = getExistingContainer();

        if (existingContainer) {
            state.domElements.container = existingContainer;

            const existingLogArea =
                document.getElementById(LOG_AREA_ID);

            state.domElements.logArea = existingLogArea;

            const isHidden =
                existingContainer.style.display === "none";

            existingContainer.style.display =
                isHidden ? "block" : "none";

            if (isHidden) {
                renderLogs();
            }

            ensureObserver();

            return;
        }

        const container = createDebuggerContainer();

        if (container) {
            container.style.display = "block";
            renderLogs();
        }

        ensureObserver();
    }

    /* ============================================================
     * 13. INITIALIZATION
     * ============================================================ */

    function initialize() {
        if (state.destroyed) {
            return;
        }

        ensureObserver();

        /*
         * We intentionally do not use setTimeout/setInterval to wait
         * for Torn's DOM.
         *
         * If body already exists, initialization can proceed.
         * Otherwise DOMContentLoaded provides the one-time lifecycle
         * event required for early execution contexts.
         */
        if (getDocumentBody()) {
            return;
        }

        if (document.readyState === "loading") {
            document.addEventListener(
                "DOMContentLoaded",
                initialize,
                { once: true }
            );
        }
    }

    initialize();

    /* ============================================================
     * 14. PUBLIC API
     * ============================================================ */

    return Object.freeze({
        /*
         * Primary logging API.
         */
        log,

        /*
         * Structured convenience methods.
         */
        info,
        warn,
        error,

        /*
         * REQUIRED BY THE USERSCRIPT ARCHITECTURE.
         *
         * Future settings UI:
         * copyButton.onclick = function () {
         *     MyDebug.copy(this);
         * };
         */
        copy: copyLogs,

        /*
         * Debugger overlay.
         */
        toggleView: toggleConsoleView,

        /*
         * Optional maintenance operation.
         */
        clear: clearLogs
    });
}
})(typeof GM_info !== "undefined" && GM_info.script
    ? GM_info : { script: { name: "Torn Job Points Default Setter" } });
