// ==UserScript==
// @name         Torn Job Points Default Setter
// @namespace    https://github.com/ShavedW00kie/
// @version      1.2.3
// @description  Saves and verifies a default job-point amount, respects field limits, and protects manual edits. Includes current diagnostic and animated support modules.
// @author       ShavedW00kie (Torn: ThaWookie [2954173] )
// @license      BSD-3-Clause
// @homepageURL  https://github.com/ShavedW00kie
// @match        https://www.torn.com/jobs.php*
// @grant        GM_info
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM_setClipboard
// @grant        GM.setClipboard
// @grant        GM_addStyle
// @run-at       document-end
// @noframes
// ==/UserScript==

(function (GM_info) {
    "use strict";

    if (window.top !== window.self || location.hostname !== "www.torn.com" ||
        location.pathname !== "/jobs.php") return;

    // The full BSD-3-Clause notices below apply to this entire userscript,
    // including the host implementation and both embedded modules.
    const MyDebug = initializeModularDebugger(GM_info.script.name);
    const VERSION = "1.2.3";
    const KEY = "tjp_default_points";
    const SELECTOR = "input[name='jobPoints'], input#jobPoints, input.job-points";
    const OWN_UI = "#tjp-settings-panel, #tjp-settings-button, [id^='tw-debug-'], [id^='us-debug-']";
    const MARKER = "data-tjp-default-setter-active";
    const MISSING = "__tjp_missing_setting__";
    const MAX_ATTEMPTS = 3;
    const MAX_BURST_WRITES = 6;
    const MAX_IDENTITIES = 200;
    const states = new WeakMap();
    const writing = new WeakSet();
    const identities = new Map();
    let parentIdentities = new WeakMap();
    const candidates = new Set();
    const checks = new Set();
    const frames = new Set();
    const replacementHints = [];
    let defaultPoints = 10;
    let settingsReady = false;
    let revision = 0;
    let settingsEpoch = 0;
    let storageBackend = null;
    let storageCandidates = [];
    let routeKey = location.href;
    let fieldSequence = 0;
    let interactionRevision = 0;
    let running = false;
    let stopped = false;
    let pending = false;
    let saveBusy = false;
    let lastStats = "";
    let panel, settingsButton, settingsInput, status, summary, saveButton, applyButton;
    let styleNode, support, bodyObserver, rootObserver, headObserver, observedBody, observedHead;

    function validPoints(value) {
        if (typeof value !== "number" && typeof value !== "string") return null;
        const text = String(value).trim();
        if (!/^\d+$/.test(text)) return null;
        const number = Number(text);
        return Number.isSafeInteger(number) && number > 0 ? number : null;
    }

    function decodeSetting(raw) {
        if (raw === MISSING || typeof raw === "undefined") return { missing: true };
        let value = raw;
        if (typeof value === "string") {
            if (value.startsWith("GMV2_")) {
                try { value = JSON.parse(value.slice(5)); }
                catch (_) { return { invalid: true }; }
            } else if (validPoints(value) === null) {
                try { value = JSON.parse(value); }
                catch (_) { return { invalid: true }; }
            }
        }
        const points = validPoints(value);
        return points === null ? { invalid: true } : { points: points };
    }

    function discoverStorage() {
        const backends = [];
        if (typeof PDA_storage !== "undefined" && PDA_storage &&
            typeof PDA_storage.get === "function" && typeof PDA_storage.set === "function") {
            backends.push({
                name: "TornPDA native",
                read: () => PDA_storage.get(KEY, MISSING),
                write: value => PDA_storage.set(KEY, value)
            });
        }
        if (typeof GM !== "undefined" && GM &&
            typeof GM.getValue === "function" && typeof GM.setValue === "function") {
            backends.push({
                name: "GM promise",
                read: () => GM.getValue(KEY, MISSING),
                write: value => GM.setValue(KEY, value)
            });
        }
        if (typeof GM_getValue === "function" && typeof GM_setValue === "function") {
            backends.push({
                name: "GM classic",
                read: () => GM_getValue(KEY, MISSING),
                write: value => GM_setValue(KEY, value)
            });
        }
        backends.push({
            name: "Browser storage",
            read: () => {
                const raw = localStorage.getItem(KEY);
                return raw === null ? MISSING : raw;
            },
            write: value => localStorage.setItem(KEY, JSON.stringify(value))
        });
        return backends;
    }

    function setStatus(message, isError = false) {
        if (!status) return;
        if (status.textContent !== message) status.textContent = message;
        status.classList.toggle("tjp-error", isError);
    }

    async function loadSettings() {
        const epoch = ++settingsEpoch;
        try {
            let loaded = null;
            let source = null;
            // Read the preferred backend first. An unreadable preferred store is
            // not permission to silently adopt a potentially stale old setting.
            for (const backend of storageCandidates) {
                const decoded = decodeSetting(await backend.read());
                if (stopped || epoch !== settingsEpoch) return;
                if (decoded.invalid) throw new Error("The saved amount is invalid.");
                if (!decoded.missing) { loaded = decoded.points; source = backend.name; break; }
            }
            defaultPoints = loaded === null ? 10 : loaded;
            settingsReady = true;
            revision++;
            interactionRevision++;
            if (panel && panel.hidden) settingsInput.value = String(defaultPoints);
            setStatus(loaded === null ? "Default amount: 10. Save to choose another amount." : "Your saved amount is loaded.");
            MyDebug.log({
                event: "settings-loaded", defaultPoints: defaultPoints,
                source: source || "first use", saveBackend: storageBackend.name
            });
            // Existing stores are retained. An explicit, verified save writes to
            // the preferred store and completes any migration without data loss.
            queueAll("settings-loaded");
        } catch (error) {
            if (stopped || epoch !== settingsEpoch) return;
            settingsReady = false;
            setStatus("Your saved amount could not be read. Choose an amount and Save before prefilling.", true);
            MyDebug.log({ event: "settings-read-failed", message: String(error) }, "ERROR");
            scheduleFlush();
        }
    }

    async function persistDefault(value) {
        const points = validPoints(value);
        if (points === null) throw new Error("Enter a positive whole number within the safe integer range.");
        if (!storageBackend) throw new Error("Storage is unavailable.");
        // An explicit save supersedes any still-pending initial read.
        ++settingsEpoch;
        await storageBackend.write(points);
        const retained = decodeSetting(await storageBackend.read());
        if (retained.points !== points) {
            throw new Error("The device did not retain the saved amount.");
        }
        if (stopped) return;
        defaultPoints = points;
        settingsReady = true;
        revision++;
        interactionRevision++;
        MyDebug.log({ event: "settings-saved", defaultPoints: points, storage: storageBackend.name });
        queueAll("settings-saved");
    }

    function isOwnUI(node) {
        return node instanceof Element && Boolean(node.closest(OWN_UI));
    }

    function isTarget(input) {
        return input instanceof HTMLInputElement && input.matches(SELECTOR) &&
            ["number", "text", "tel"].includes(input.type) && !isOwnUI(input);
    }

    function allTargets(root = document) {
        const found = [];
        if (root instanceof Element && isOwnUI(root)) return found;
        if (root instanceof Element && isTarget(root)) found.push(root);
        if (root && typeof root.querySelectorAll === "function") {
            for (const input of root.querySelectorAll(SELECTOR)) {
                if (isTarget(input)) found.push(input);
            }
        }
        return found;
    }

    function updateRoute() {
        if (location.href === routeKey) return;
        routeKey = location.href;
        identities.clear();
        parentIdentities = new WeakMap();
        replacementHints.length = 0;
        interactionRevision++;
        MyDebug.log({ event: "page-route-changed" }, "DEBUG");
    }

    function newOwnership(input) {
        return { manual: false, external: false, value: null, node: input };
    }

    function findOwnership(input) {
        const signature = JSON.stringify([input.id, input.getAttribute("name") || "", input.type]);
        // A same-commit replacement with no stable identity can still retain
        // an edited value. Protect that value conservatively rather than
        // guessing a row index or restoring an amount into a different field.
        const hint = replacementHints.find(item => item.parent.isConnected &&
            item.parent.contains(input) && item.signature === signature &&
            item.value === input.value && !item.previous.isConnected);
        if (hint) {
            const retained = { ...hint.ownership, node: input };
            MyDebug.log({ event: "replacement-value-protected", fieldIdentity: "same mutation context" }, "DEBUG");
            return retained;
        }
        const fields = allTargets();
        let key = null;
        // Only unambiguous IDs or a named field within a uniquely identified
        // form/container are reused across replaced controls. No row indexes.
        if (input.id && fields.filter(item => item.id === input.id).length === 1) {
            key = "id:" + input.id + ":" + signature;
        } else {
            let ancestor = input.parentElement;
            for (let depth = 0; ancestor && depth < 6; depth++, ancestor = ancestor.parentElement) {
                if (!ancestor.id || ancestor === document.body || ancestor === document.documentElement) continue;
                if (Array.from(document.querySelectorAll("[id]")).filter(node => node.id === ancestor.id).length !== 1) continue;
                if (allTargets(ancestor).filter(item =>
                    JSON.stringify([item.id, item.getAttribute("name") || "", item.type]) === signature).length === 1) {
                    key = "container:" + ancestor.id + ":" + signature;
                    break;
                }
            }
        }
        let table;
        if (key) table = identities;
        else {
            const parent = input.parentElement;
            if (!parent || allTargets(parent).filter(item =>
                JSON.stringify([item.id, item.getAttribute("name") || "", item.type]) === signature).length !== 1) {
                return newOwnership(input);
            }
            if (!parentIdentities.has(parent)) parentIdentities.set(parent, new Map());
            table = parentIdentities.get(parent);
            key = signature;
        }
        let ownership = table.get(key);
        if (!ownership || (ownership.node !== input && ownership.node && ownership.node.isConnected)) {
            ownership = newOwnership(input);
            table.set(key, ownership);
        } else if (ownership.node !== input) {
            ownership.node = input;
            if (ownership.manual || ownership.external) {
                MyDebug.log({ event: "replacement-override-protected", manual: ownership.manual }, "DEBUG");
            }
        }
        if (table === identities && table.size > MAX_IDENTITIES) {
            for (const [oldKey, old] of table) {
                if (!old.node || !old.node.isConnected) { table.delete(oldKey); break; }
            }
        }
        return ownership;
    }

    function getState(input) {
        let state = states.get(input);
        if (state) return state;
        updateRoute();
        state = {
            id: ++fieldSequence, ownership: findOwnership(input),
            appliedValue: null, cycle: "", attempts: 0, blocked: false,
            reason: "", checkQueued: false, burstWrites: 0,
            interactionRevision: interactionRevision
        };
        states.set(input, state);
        return state;
    }

    function numericAttribute(input, name) {
        const text = input.getAttribute(name);
        if (text === null || text.trim() === "") return null;
        if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text.trim())) return null;
        const number = Number(text);
        return Number.isFinite(number) ? number : null;
    }

    function constraintsFor(input, requested = defaultPoints) {
        const fingerprint = JSON.stringify([
            input.type, input.getAttribute("min"), input.getAttribute("max"),
            input.getAttribute("step"), input.getAttribute("value"), requested, revision
        ]);
        const reject = reason => ({ value: null, reason: reason, fingerprint: fingerprint });
        const min = numericAttribute(input, "min");
        const max = numericAttribute(input, "max");
        const low = Math.max(1, Math.ceil(min === null ? 1 : min));
        const high = Math.min(Number.MAX_SAFE_INTEGER, Math.floor(max === null ? Number.MAX_SAFE_INTEGER : max));
        if (low > high) return reject("no-positive-value-within-limits");
        const clamped = Math.max(low, Math.min(requested, high));
        const rawStep = input.getAttribute("step");
        if (rawStep !== null && rawStep.trim().toLowerCase() === "any") {
            return { value: clamped, fingerprint: fingerprint };
        }
        const step = numericAttribute(input, "step") === null ? 1 : numericAttribute(input, "step");
        const base = min === null ? (numericAttribute(input, "value") || 0) : min;
        if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high) ||
            !Number.isSafeInteger(base) || !Number.isSafeInteger(step) || step < 1) {
            return reject("unsupported-integer-step-or-base");
        }
        if (typeof BigInt === "function") {
            const lo = BigInt(low), hi = BigInt(high), by = BigInt(step), origin = BigInt(base);
            const mod = value => ((value % by) + by) % by;
            const first = lo + mod(origin - lo), last = hi - mod(hi - origin);
            if (first > last) return reject("no-integer-value-on-step-grid");
            const target = BigInt(clamped);
            const aligned = target - mod(target - origin);
            return { value: Number(aligned < first ? first : aligned > last ? last : aligned), fingerprint: fingerprint };
        }
        // Older engines still support ordinary job-point amounts. Fail closed
        // rather than round an unsafe intermediate on extreme constraints.
        if (![base - low, high - base, clamped - base].every(Number.isSafeInteger)) {
            return reject("constraints-exceed-engine-integer-precision");
        }
        const mod = value => {
            const remainder = value % step;
            return remainder < 0 ? remainder + step : remainder;
        };
        const first = low + mod(base - low), last = high - mod(high - base);
        if (first > last) return reject("no-integer-value-on-step-grid");
        return { value: Math.max(first, Math.min(clamped - mod(clamped - base), last)), fingerprint: fingerprint };
    }

    function skip(state, reason) {
        if (state.reason !== reason) {
            state.reason = reason;
            MyDebug.log({ event: "field-skipped", field: state.id, reason: reason }, "DEBUG");
        }
    }

    function queueCheck(input, state) {
        if (state.checkQueued || stopped) return;
        state.checkQueued = true;
        checks.add(input);
        scheduleFrame(() => {
            state.checkQueued = false;
            checks.delete(input);
            if (stopped || !input.isConnected || !isTarget(input)) return;
            candidates.add(input);
            scheduleFlush();
        });
    }

    function reconcileInput(input) {
        if (stopped || !isTarget(input) || !input.isConnected) return;
        const state = getState(input);
        if (state.interactionRevision !== interactionRevision) {
            state.interactionRevision = interactionRevision;
            state.burstWrites = 0;
            state.cycle = "";
        }
        if (!settingsReady) { skip(state, "saved-setting-unavailable"); return; }
        if (state.ownership.manual || state.ownership.external) {
            skip(state, state.ownership.manual ? "manual-edit-protected" : "external-edit-protected");
            return;
        }
        if (input.matches(":disabled") || input.readOnly) { skip(state, "disabled-or-readonly"); return; }
        if (document.activeElement === input) { skip(state, "currently-focused"); return; }
        const constrained = constraintsFor(input);
        if (constrained.value === null) { skip(state, constrained.reason); return; }
        if (state.cycle !== constrained.fingerprint) {
            state.cycle = constrained.fingerprint;
            state.attempts = 0;
            state.blocked = false;
        }
        const desired = String(constrained.value);
        if (input.value === desired) {
            state.appliedValue = desired;
            state.reason = "";
            return;
        }
        if (state.blocked || state.attempts >= MAX_ATTEMPTS || state.burstWrites >= MAX_BURST_WRITES) {
            state.blocked = true;
            skip(state, "page-rejected-default");
            return;
        }
        const previous = state.appliedValue;
        let accepted = false;
        try {
            state.attempts++;
            state.burstWrites++;
            writing.add(input);
            const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
            if (!descriptor || typeof descriptor.set !== "function") throw new Error("Native input setter unavailable.");
            descriptor.set.call(input, desired);
            state.appliedValue = desired;
            input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
            // A reset from the first handler must not notify change listeners
            // with the wrong amount. No click or form submission is generated.
            if (input.isConnected && input.value === desired &&
                !state.ownership.manual && !state.ownership.external) {
                input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
            }
            accepted = input.isConnected && input.value === desired;
            state.reason = accepted ? "" : "page-reset-during-update";
            MyDebug.log({
                event: accepted ? "default-applied" : "default-not-retained",
                field: state.id, requested: defaultPoints, applied: constrained.value,
                attempt: state.attempts
            }, accepted ? "INFO" : "WARN");
        } catch (error) {
            state.appliedValue = previous;
            state.reason = "input-update-failed";
            MyDebug.log({ event: "input-update-failed", field: state.id, message: String(error) }, "ERROR");
        } finally {
            writing.delete(input);
        }
        // Bounded verification after our own writes, never an element-wait loop.
        // Repeated rejection stops until a setting/constraint change or Apply.
        queueCheck(input, state);
    }

    function onFieldEvent(event) {
        const input = event.target;
        if (!isTarget(input) || writing.has(input)) return;
        const state = getState(input);
        if (event.isTrusted) {
            state.ownership.manual = true;
            state.ownership.value = input.value;
            skip(state, "manual-edit-protected");
        } else if (state.appliedValue !== null && input.value !== state.appliedValue) {
            // Another script's explicit edit is not permission to fight it.
            state.ownership.external = true;
            state.ownership.value = input.value;
            skip(state, "external-edit-protected");
        }
        candidates.add(input);
        scheduleFlush();
    }

    function scheduleFrame(callback) {
        if (stopped) return;
        if (typeof requestAnimationFrame !== "function") {
            Promise.resolve().then(() => { if (!stopped) callback(); });
            return;
        }
        const handle = requestAnimationFrame(() => {
            frames.delete(handle);
            if (!stopped) callback();
        });
        frames.add(handle);
    }

    function enqueue(root) {
        for (const input of allTargets(root)) candidates.add(input);
    }

    function queueAll(reason) {
        updateRoute();
        enqueue(document);
        MyDebug.log({ event: "fields-queued", reason: reason, count: candidates.size }, "DEBUG");
        scheduleFlush();
    }

    function scheduleFlush() {
        if (pending || stopped || !running) return;
        pending = true;
        scheduleFrame(flush);
    }

    function flush() {
        pending = false;
        if (stopped || !running) return;
        updateRoute();
        ensureMounted();
        const batch = Array.from(candidates);
        candidates.clear();
        for (const input of batch) reconcileInput(input);
        replacementHints.length = 0;
        updateSummary();
    }

    function updateSummary() {
        if (!summary || stopped) return;
        const counts = { detected: 0, usingDefault: 0, protected: 0, skipped: 0 };
        for (const input of allTargets()) {
            counts.detected++;
            const state = states.get(input);
            if (state && (state.ownership.manual || state.ownership.external)) counts.protected++;
            else if (state && state.appliedValue !== null && input.value === state.appliedValue &&
                !state.reason && !input.matches(":disabled") && !input.readOnly) counts.usingDefault++;
            else counts.skipped++;
        }
        const text = !counts.detected ? "No job-point fields detected yet. Open a job special to check its fields." :
            "Detected " + counts.detected + " field(s): " + counts.usingDefault + " using the default, " +
            counts.protected + " kept after edits, " + counts.skipped + " waiting or skipped.";
        if (summary.textContent !== text) summary.textContent = text;
        applyButton.disabled = !settingsReady || saveBusy || !counts.detected;
        const signature = JSON.stringify(counts);
        if (signature !== lastStats) {
            lastStats = signature;
            MyDebug.log({ event: "field-summary", counts: counts }, counts.detected ? "INFO" : "WARN");
        }
    }

    function handleMutations(records) {
        let relevant = false;
        // Process removals before additions, including replacements delivered
        // as separate records in one observer batch.
        for (const record of records) {
            if (record.type !== "childList" || isOwnUI(record.target)) continue;
            for (const removed of record.removedNodes) {
                for (const old of allTargets(removed)) {
                    const state = states.get(old);
                    if (!state || (!state.ownership.manual && !state.ownership.external)) continue;
                    replacementHints.push({
                        parent: record.target, previous: old, value: old.value,
                        signature: JSON.stringify([old.id, old.getAttribute("name") || "", old.type]),
                        ownership: state.ownership
                    });
                    if (replacementHints.length > 100) replacementHints.shift();
                }
            }
        }
        for (const record of records) {
            if (isOwnUI(record.target)) continue;
            if (record.type === "attributes") {
                if (record.target instanceof HTMLInputElement) { candidates.add(record.target); relevant = true; }
                else if (record.attributeName === "disabled" && record.target.tagName === "FIELDSET") {
                    enqueue(record.target); relevant = true;
                }
            } else {
                for (const added of record.addedNodes) {
                    if (added instanceof Element && !isOwnUI(added)) { enqueue(added); relevant = true; }
                }
                if (record.removedNodes.length) relevant = true;
            }
        }
        if (relevant || !panel.isConnected || !settingsButton.isConnected) scheduleFlush();
    }

    function watchDocumentParts() {
        if (document.body !== observedBody) {
            if (bodyObserver) bodyObserver.disconnect();
            observedBody = document.body;
            if (observedBody) {
                bodyObserver = new MutationObserver(handleMutations);
                bodyObserver.observe(observedBody, {
                    childList: true, subtree: true, attributes: true,
                    attributeFilter: ["name", "id", "class", "type", "disabled", "readonly", "min", "max", "step", "value"]
                });
                enqueue(observedBody);
            }
        }
        if (document.head !== observedHead) {
            if (headObserver) headObserver.disconnect();
            observedHead = document.head;
            if (observedHead) {
                headObserver = new MutationObserver(() => {
                    if (!styleNode || !styleNode.isConnected || (support &&
                        !document.getElementById(support.config.styleId))) scheduleFlush();
                });
                headObserver.observe(observedHead, { childList: true });
            }
        }
    }

    function ensureMounted() {
        if (!document.body) return;
        watchDocumentParts();
        if (!styleNode || !styleNode.isConnected) injectHostStyle();
        if (!panel.isConnected) document.body.appendChild(panel);
        const header = [".content-title", "#top-page-links", ".title-black"]
            .map(selector => document.querySelector(selector)).find(node => node && !isOwnUI(node));
        const host = header || document.body;
        settingsButton.classList.toggle("tjp-floating", !header);
        if (settingsButton.parentNode !== host) host.appendChild(settingsButton);
        if (support) { support.injectStyles(); support.injectUI(); }
    }

    function element(tag, attributes = {}, text = "") {
        const node = document.createElement(tag);
        for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
        if (text) node.textContent = text;
        return node;
    }

    function injectHostStyle() {
        if (styleNode && styleNode.isConnected) return;
        styleNode = element("style", { id: "tjp-host-style" });
        styleNode.textContent = [
            "#tjp-settings-button,#tjp-settings-panel button{font:inherit;min-height:44px;padding:8px 12px;cursor:pointer;border:1px solid #687381;border-radius:6px;background:#26364a;color:#fff;touch-action:manipulation}",
            "#tjp-settings-button{margin-left:12px;font-weight:bold}",
            "#tjp-settings-button.tjp-floating{position:fixed;bottom:16px;right:16px;z-index:99998}",
            "#tjp-settings-panel{box-sizing:border-box;position:fixed;top:60px;right:12px;width:400px;max-width:calc(100vw - 24px);max-height:calc(100vh - 80px);overflow:auto;padding:16px;background:#222;color:#eee;border:1px solid #697482;border-radius:10px;z-index:99999;box-shadow:0 8px 28px #0008;font:14px/1.5 Arial,sans-serif}",
            "#tjp-settings-panel[hidden]{display:none!important}",
            "#tjp-settings-panel h3,#tjp-settings-panel h4{margin:0 0 10px;color:#fff}",
            "#tjp-settings-panel h4{margin-top:16px;border-top:1px solid #555;padding-top:12px}",
            "#tjp-settings-panel input{box-sizing:border-box;width:100%;min-height:44px;margin:8px 0;padding:8px;font-size:16px;background:#fff;color:#111}",
            "#tjp-settings-panel .tjp-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}",
            "#tjp-settings-panel p{margin:8px 0}",
            "#tjp-settings-panel .tjp-error{color:#ffc0b8}",
            "#tjp-settings-panel .tjp-small{font-size:12px;color:#ccc}",
            "#tjp-settings-panel button:disabled{opacity:.55;cursor:default}",
            "#tjp-settings-panel button:focus-visible,#tjp-settings-button:focus-visible{outline:3px solid #84bcff;outline-offset:2px}",
            "@media(max-width:480px){#tjp-settings-panel{top:40px;right:8px;max-width:calc(100vw - 16px);max-height:calc(100vh - 56px);padding:12px}}"
        ].join("\n");
        (document.head || document.body).appendChild(styleNode);
    }

    function closeSettings() {
        panel.hidden = true;
        settingsButton.setAttribute("aria-expanded", "false");
        settingsButton.focus();
    }

    function openSettings() {
        ensureMounted();
        if (panel.hidden) settingsInput.value = String(defaultPoints);
        panel.hidden = false;
        settingsButton.setAttribute("aria-expanded", "true");
        updateSummary();
        settingsInput.focus();
    }

    async function saveFromUI(event) {
        event.preventDefault();
        if (saveBusy) return;
        const value = validPoints(settingsInput.value);
        if (value === null) { setStatus("Enter a positive whole number within the safe integer range.", true); settingsInput.focus(); return; }
        saveBusy = true;
        saveButton.disabled = true;
        applyButton.disabled = true;
        setStatus("Saving and checking the amount...");
        try {
            await persistDefault(value);
            setStatus("Saved and verified. Default JP amount: " + value + ".");
        } catch (error) {
            setStatus("Could not verify the save. Your active default was not changed. Try again or copy the logs.", true);
            MyDebug.log({ event: "settings-save-failed", message: String(error) }, "ERROR");
        } finally {
            saveBusy = false;
            saveButton.disabled = false;
            updateSummary();
        }
    }

    function applyNow() {
        if (!settingsReady || saveBusy) return;
        const inputs = allTargets();
        for (const input of inputs) {
            const state = getState(input);
            state.ownership.manual = false;
            state.ownership.external = false;
            state.ownership.value = null;
            state.attempts = 0;
            state.burstWrites = 0;
            state.blocked = false;
            state.cycle = "";
            candidates.add(input);
        }
        setStatus("Applying the saved amount to current fields where their limits allow.");
        MyDebug.log({ event: "explicit-apply", count: inputs.length });
        scheduleFlush();
    }

    function buildSettings() {
        settingsButton = element("button", {
            id: "tjp-settings-button", type: "button", "aria-controls": "tjp-settings-panel", "aria-expanded": "false"
        }, "JP Settings");
        settingsButton.addEventListener("click", openSettings);
        panel = element("section", { id: "tjp-settings-panel", role: "dialog", "aria-labelledby": "tjp-title" });
        panel.hidden = true;
        const title = element("h3", { id: "tjp-title" }, "Job Points Default");
        const version = element("p", { class: "tjp-small" }, "Version " + VERSION);
        const form = element("form", { id: "tjp-form", novalidate: "" });
        const label = element("label", { for: "tjp-input" }, "Default JP amount");
        settingsInput = element("input", {
            id: "tjp-input", type: "number", inputmode: "numeric", min: "1", step: "1",
            max: String(Number.MAX_SAFE_INTEGER), required: "", "aria-describedby": "tjp-help"
        });
        settingsInput.value = String(defaultPoints);
        const help = element("p", { id: "tjp-help" }, "Prefills detected job-point fields within their declared limits. You still choose when to spend.");
        const manualHelp = element("p", { class: "tjp-small" }, "Save keeps edited fields. Apply saved default now replaces current amounts, including your edits.");
        const actions = element("div", { class: "tjp-actions" });
        saveButton = element("button", { id: "tjp-save", type: "submit" }, "Save");
        applyButton = element("button", { id: "tjp-apply", type: "button" }, "Apply saved default now");
        applyButton.disabled = true;
        const close = element("button", { id: "tjp-close", type: "button" }, "Close");
        actions.append(saveButton, applyButton, close);
        form.append(label, settingsInput, help, manualHelp, actions);
        status = element("p", { id: "tjp-status", role: "status", "aria-live": "polite" }, "Loading your saved amount...");
        summary = element("p", { id: "tjp-summary", class: "tjp-small", "aria-live": "polite" });
        const debugActions = element("div", { class: "tjp-actions" });
        const debug = element("button", { id: "tjp-debug", type: "button", "aria-label": "Toggle diagnostic log" }, "🪲");
        const copy = element("button", { id: "tjp-copy", type: "button" }, "📋 Copy Logs to Clipboard");
        debugActions.append(debug, copy);
        const supportHost = element("div", { id: "tjp-support-host" });
        const tipHelp = element("p", { class: "tjp-small" }, "To tip in Torn: open Items, find Xanax, choose Send, then enter ThaWookie [2954173].");
        panel.append(title, version, form, status, summary,
            element("h4", {}, "Diagnostics"), debugActions, element("h4", {}, "Support ThaWookie"), supportHost, tipHelp);
        form.addEventListener("submit", saveFromUI);
        applyButton.addEventListener("click", applyNow);
        close.addEventListener("click", closeSettings);
        debug.addEventListener("click", () => MyDebug.toggleView());
        copy.addEventListener("click", function () { void MyDebug.copy(this); });
        panel.addEventListener("keydown", event => {
            if (event.key === "Escape") { event.stopPropagation(); closeSettings(); }
        });
        document.body.appendChild(panel);
        support = new SupportModule({ host: supportHost });
    }

    function onFocusOut(event) {
        if (!isTarget(event.target)) return;
        candidates.add(event.target);
        scheduleFlush();
    }

    function onNavigation() {
        updateRoute();
        queueAll("navigation");
    }

    function onPageInteraction(event) {
        if (!event.isTrusted || isOwnUI(event.target)) return;
        interactionRevision++;
        enqueue(document);
        scheduleFlush();
    }

    function onStorage(event) {
        if (event.key === KEY && !saveBusy) void loadSettings();
    }

    function stop(event) {
        if (event && event.persisted) return;
        stopped = true;
        for (const observer of [bodyObserver, rootObserver, headObserver]) if (observer) observer.disconnect();
        for (const handle of frames) if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle);
        frames.clear();
        candidates.clear();
        checks.clear();
        replacementHints.length = 0;
        identities.clear();
        for (const type of ["beforeinput", "input", "change", "compositionstart"]) document.removeEventListener(type, onFieldEvent, true);
        document.removeEventListener("focusout", onFocusOut, true);
        document.removeEventListener("click", onPageInteraction, true);
        document.removeEventListener("keydown", onPageInteraction, true);
        window.removeEventListener("hashchange", onNavigation);
        window.removeEventListener("popstate", onNavigation);
        window.removeEventListener("storage", onStorage);
        window.removeEventListener("pagehide", stop);
        if (support) support.destroy();
        MyDebug.destroy();
        if (panel) panel.remove();
        if (settingsButton) settingsButton.remove();
        if (styleNode) styleNode.remove();
        if (document.documentElement.getAttribute(MARKER) === VERSION) document.documentElement.removeAttribute(MARKER);
    }

    async function boot() {
        if (running || stopped) return;
        if (document.documentElement.hasAttribute(MARKER) || document.getElementById("tjp-settings-panel")) {
            MyDebug.log({ event: "duplicate-injection-skipped", action: "Reload the page after replacing a running script." }, "WARN");
            return;
        }
        document.documentElement.setAttribute(MARKER, VERSION);
        running = true;
        storageCandidates = discoverStorage();
        storageBackend = storageCandidates[0];
        for (const type of ["beforeinput", "input", "change", "compositionstart"]) document.addEventListener(type, onFieldEvent, true);
        document.addEventListener("focusout", onFocusOut, true);
        document.addEventListener("click", onPageInteraction, true);
        document.addEventListener("keydown", onPageInteraction, true);
        window.addEventListener("hashchange", onNavigation);
        window.addEventListener("popstate", onNavigation);
        window.addEventListener("storage", onStorage);
        window.addEventListener("pagehide", stop);
        buildSettings();
        rootObserver = new MutationObserver(() => {
            watchDocumentParts();
            scheduleFlush();
        });
        rootObserver.observe(document.documentElement, { childList: true });
        ensureMounted();
        MyDebug.log({
            event: "initialized", version: VERSION, storage: storageBackend.name,
            debugger: "1.0.5 (supplied 1.0.4 plus clipboard fix)",
            donation: "1.4.1 (supplied 1.4 settings adapter)", apiRequests: 0
        });
        scheduleFlush();
        await loadSettings();
    }

    function start() {
        void boot().catch(error => {
            setStatus("Initialization failed. Copy the diagnostic logs and reload the page.", true);
            MyDebug.log({ event: "initialization-failed", message: String(error) }, "ERROR");
        });
    }

    /* Embedded donation module, retaining all supplied visual features. */
/*
 * Donation UI Module
 * Version 1.4.1 (settings adapter of the supplied v1.4)
 *
 * Reusable support/donation UI for Torn.com userscripts.
 *
 * Features:
 *   - Animated Buy Me a Coffee button
 *   - Animated coffee cup with squash-and-stretch movement
 *   - Animated steam
 *   - Animated coffee fill
 *   - Hover-to-fill coffee effect
 *   - Periodic diagonal button gleam
 *   - Animated liquid-style label transition
 *   - Torn Xanax-tip button
 *   - MutationObserver persistence against Torn/React DOM changes
 *   - TornPDA/mobile-compatible DOM implementation
 *   - Reduced-motion accessibility support
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
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its
 *    contributors may be used to endorse or promote products derived from
 *    this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
 * HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 * LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 * DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 * THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

    /* ============================================================
     * CONFIGURATION
     * ============================================================ */

    const DEFAULT_CONFIG = Object.freeze({
        bmcId: "bittick1c",
        tornUserId: "2954173",

        containerId: "tjp-support-module",
        styleId: "tjp-support-module-style"
    });

    /*
     * Unique counter used for SVG clipPath IDs.
     *
     * SVG IDs are document-global. If multiple instances of this
     * module are ever created, sharing a clipPath ID can cause one
     * SVG to reference another SVG's clipping path.
     */
    let coffeeInstanceCount = 0;

    /* ============================================================
     * SUPPORT MODULE
     * ============================================================ */

    class SupportModule {
        constructor(config = {}) {
            this.config = {
                ...DEFAULT_CONFIG,
                ...config
            };

            this.host = config.host || null;
            this.observer = null;
            this.observerAttached = false;
            this.isInjecting = false;
            this.destroyed = false;

            this.init();
        }

        /* ========================================================
         * INITIALIZATION
         * ======================================================== */

        init() {
            if (this.destroyed) {
                return;
            }

            if (!this.getBody()) {
                if (document.readyState === "loading") {
                    document.addEventListener(
                        "DOMContentLoaded",
                        () => this.init(),
                        { once: true }
                    );
                }

                return;
            }

            this.injectStyles();
            this.injectUI();
            this.attachObserver();
        }

        /* ========================================================
         * DOM HELPERS
         * ======================================================== */

        getBody() {
            return document.body || null;
        }

        getContainer() {
            return document.getElementById(
                this.config.containerId
            );
        }

        isContainerConnected() {
            const container = this.getContainer();

            return Boolean(
                container &&
                container.isConnected
            );
        }

        /* ========================================================
         * STYLE INJECTION
         * ======================================================== */

        injectStyles() {
            if (this.destroyed) {
                return;
            }

            if (document.getElementById(this.config.styleId)) {
                return;
            }

            const styles = `
                /* =================================================
                 * DONATION CONTAINER
                 * ================================================= */

                #${this.config.containerId} {
                    position: static;
                    width: 100%;
                    display: flex;
                    flex-direction: column;
                    gap: 10px;
                    font-family: Arial, sans-serif;
                    box-sizing: border-box;
                    touch-action: manipulation;
                }

                /* =================================================
                 * GENERIC SUPPORT BUTTON
                 * ================================================= */

                #${this.config.containerId} .tw-support-btn {
                    box-sizing: border-box;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    min-height: 40px;
                    padding: 10px 15px;
                    border-radius: 8px;
                    font-size: 13px;
                    font-weight: bold;
                    line-height: 1.2;
                    text-align: center;
                    text-decoration: none !important;
                    cursor: pointer;
                    user-select: none;
                    -webkit-tap-highlight-color: transparent;
                    touch-action: manipulation;
                }

                #${this.config.containerId} .tw-support-btn:focus-visible {
                    outline: 2px solid #ffffff;
                    outline-offset: 2px;
                }

                /* =================================================
                 * BUY ME A COFFEE BUTTON
                 *
                 * Visual design ported from the supplied animated
                 * coffee-button implementation:
                 *
                 *   #FFDD00 yellow
                 *   black foreground
                 *   6px radius
                 *   6px 12px compact padding
                 *   11px / 600 typography
                 *   animated glare
                 *   animated cup
                 * ================================================= */

                #${this.config.containerId} .tw-bmc {
                    position: relative;
                    overflow: hidden;
                    isolation: isolate;

                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 6px;

                    width: 100%;
                    min-width: 170px;
                    min-height: 40px;

                    padding: 6px 12px;

                    background: #FFDD00;
                    color: #000000 !important;

                    border: 1px solid #FFDD00;
                    border-radius: 6px;

                    font-size: 11px;
                    font-weight: 600;
                    line-height: 1.2;

                    text-decoration: none !important;

                    box-sizing: border-box;

                    transition:
                        opacity 0.15s ease,
                        transform 0.15s ease;
                }

                /*
                 * Keep all actual button contents above the
                 * animated specular highlight.
                 */
                #${this.config.containerId} .tw-bmc > * {
                    position: relative;
                    z-index: 1;
                }

                /*
                 * Subtle interaction feedback.
                 *
                 * Hover is deliberately opacity-based rather than
                 * relying on desktop-only behavior for functionality.
                 * The button remains fully usable through touch.
                 */
                #${this.config.containerId} .tw-bmc:hover {
                    opacity: 0.9;
                }

                #${this.config.containerId} .tw-bmc:active {
                    transform: scale(0.97);
                }

                /* =================================================
                 * COFFEE CUP : SQUASH & STRETCH
                 * ================================================= */

                @keyframes tw-coffee-cup-hop {
                    0% {
                        transform:
                            translateY(0)
                            scale(1, 1);
                    }

                    18% {
                        transform:
                            translateY(0.5px)
                            scale(1.08, 0.9);
                    }

                    32% {
                        transform:
                            translateY(-2px)
                            scale(0.94, 1.08);
                    }

                    50% {
                        transform:
                            translateY(-3px)
                            scale(1, 1);
                    }

                    68% {
                        transform:
                            translateY(0)
                            scale(1.1, 0.88);
                    }

                    84% {
                        transform:
                            translateY(0)
                            scale(0.97, 1.03);
                    }

                    100% {
                        transform:
                            translateY(0)
                            scale(1, 1);
                    }
                }

                #${this.config.containerId} .tw-coffee-cup {
                    position: relative;
                    display: inline-flex;
                    flex-shrink: 0;

                    transform-origin: 50% 100%;

                    animation:
                        tw-coffee-cup-hop
                        2.4s
                        cubic-bezier(0.4, 0, 0.5, 1)
                        infinite;
                }

                /*
                 * Cup outline remains above the steam.
                 */
                #${this.config.containerId} .tw-coffee-cup > svg {
                    position: relative;
                    z-index: 1;
                    display: block;
                }

                /* =================================================
                 * STEAM
                 * ================================================= */

                #${this.config.containerId} .tw-coffee-cup::before,
                #${this.config.containerId} .tw-coffee-cup::after {
                    content: "";

                    position: absolute;

                    bottom: 74%;

                    width: 2px;
                    height: 4px;

                    border-radius: 999px;

                    background:
                        linear-gradient(
                            to top,
                            rgba(90, 58, 36, 0.5),
                            rgba(90, 58, 36, 0)
                        );

                    opacity: 0;

                    pointer-events: none;

                    will-change:
                        transform,
                        opacity;
                }

                #${this.config.containerId} .tw-coffee-cup::before {
                    left: 27%;

                    animation:
                        tw-coffee-steam
                        2.8s
                        ease-out
                        infinite;
                }

                #${this.config.containerId} .tw-coffee-cup::after {
                    left: 45%;

                    animation:
                        tw-coffee-steam
                        2.8s
                        ease-out
                        infinite;

                    animation-delay: -1.4s;
                }

                @keyframes tw-coffee-steam {
                    0% {
                        opacity: 0;

                        transform:
                            translateY(2px)
                            scale(0.6, 0.5)
                            skewX(0deg);
                    }

                    30% {
                        opacity: 0.7;

                        transform:
                            translateY(0)
                            scale(1, 0.9)
                            skewX(4deg);
                    }

                    65% {
                        opacity: 0.4;

                        transform:
                            translateY(-3px)
                            scale(0.85, 1.2)
                            skewX(-5deg);
                    }

                    100% {
                        opacity: 0;

                        transform:
                            translateY(-5px)
                            scale(0.5, 1.5)
                            skewX(6deg);
                    }
                }

                /* =================================================
                 * COFFEE FILL
                 * ================================================= */

                #${this.config.containerId} .tw-coffee-fill {
                    transform: scaleY(0.15);
                    transform-origin: 50% 100%;

                    animation:
                        tw-coffee-refill
                        7s
                        cubic-bezier(0.45, 0, 0.55, 1)
                        infinite;
                }

                @keyframes tw-coffee-refill {
                    0% {
                        transform: scaleY(0.15);
                    }

                    30% {
                        transform: scaleY(0.95);
                    }

                    55% {
                        transform: scaleY(0.75);
                    }

                    80% {
                        transform: scaleY(0.3);
                    }

                    100% {
                        transform: scaleY(0.15);
                    }
                }

                /*
                 * Hover overrides the normal coffee cycle and fills
                 * the cup completely.
                 */
                #${this.config.containerId}
                .tw-bmc:hover
                .tw-coffee-fill {
                    animation:
                        tw-coffee-fill-to-full
                        0.45s
                        cubic-bezier(0.4, 0, 0.2, 1)
                        forwards;
                }

                @keyframes tw-coffee-fill-to-full {
                    to {
                        transform: scaleY(1);
                    }
                }

                /* =================================================
                 * SPECULAR GLEAM
                 * ================================================= */

                /*
                 * A soft diagonal highlight sweeps across the
                 * yellow button every five seconds.
                 */
                #${this.config.containerId} .tw-bmc::after {
                    content: "";

                    position: absolute;

                    top: 0;
                    bottom: 0;
                    left: -60%;

                    width: 45%;

                    pointer-events: none;

                    background:
                        linear-gradient(
                            100deg,
                            transparent 0%,
                            rgba(255, 255, 255, 0.15) 35%,
                            rgba(255, 255, 255, 0.75) 50%,
                            rgba(255, 255, 255, 0.15) 65%,
                            transparent 100%
                        );

                    transform: skewX(-18deg);

                    will-change: transform;

                    animation:
                        tw-coffee-glare
                        5s
                        cubic-bezier(0.5, 0, 0.5, 1)
                        infinite;
                }

                @keyframes tw-coffee-glare {
                    0% {
                        transform:
                            translateX(0)
                            skewX(-18deg);
                    }

                    22%,
                    100% {
                        transform:
                            translateX(400%)
                            skewX(-18deg);
                    }
                }

                /* =================================================
                 * LIQUID LABEL TRANSITION
                 * ================================================= */

                #${this.config.containerId} .tw-coffee-label {
                    display: grid;
                    align-items: center;
                    justify-items: center;

                    min-width: 0;
                }

                #${this.config.containerId} .tw-coffee-label > span {
                    grid-area: 1 / 1;

                    white-space: nowrap;

                    transform-origin: 50% 50%;

                    will-change:
                        opacity,
                        transform,
                        filter;

                    animation:
                        tw-coffee-label-drip
                        7s
                        cubic-bezier(0.65, 0, 0.35, 1)
                        infinite;
                }

                /*
                 * The second label is exactly 50% out of phase,
                 * creating the alternating liquid transition.
                 */
                #${this.config.containerId}
                .tw-coffee-label
                > span:nth-child(2) {
                    animation-delay: -3.5s;
                }

                @keyframes tw-coffee-label-drip {
                    0%,
                    34% {
                        opacity: 1;

                        transform:
                            translateY(0)
                            scale(1, 1);

                        filter: blur(0);
                    }

                    38% {
                        opacity: 0.5;

                        transform:
                            translateY(2px)
                            scale(0.94, 1.08);

                        filter: blur(1.2px);
                    }

                    42% {
                        opacity: 0;

                        transform:
                            translateY(9px)
                            scale(1.06, 0.5);

                        filter: blur(4px);
                    }

                    42.01%,
                    92% {
                        opacity: 0;

                        transform:
                            translateY(-9px)
                            scale(1.06, 0.5);

                        filter: blur(4px);
                    }

                    96% {
                        opacity: 1;

                        transform:
                            translateY(1px)
                            scale(1.05, 0.9);

                        filter: blur(0);
                    }

                    98% {
                        opacity: 1;

                        transform:
                            translateY(0)
                            scale(0.99, 1.03);

                        filter: blur(0);
                    }

                    100% {
                        opacity: 1;

                        transform:
                            translateY(0)
                            scale(1, 1);

                        filter: blur(0);
                    }
                }

                /* =================================================
                 * TORN TIP BUTTON
                 * ================================================= */

                #${this.config.containerId} .tw-torn-tip {
                    background-color: #8ab63d;
                    color: #ffffff !important;

                    border: 1px solid #6a8c2f;

                    box-shadow:
                        0 4px 6px rgba(0, 0, 0, 0.3);

                    transition:
                        transform 0.2s ease,
                        background-color 0.2s ease;
                }

                #${this.config.containerId} .tw-torn-tip:active {
                    transform: scale(0.95);
                }

                /* =================================================
                 * REDUCED MOTION
                 * ================================================= */

                @media (prefers-reduced-motion: reduce) {
                    #${this.config.containerId}
                    .tw-coffee-cup {
                        animation: none;
                    }

                    #${this.config.containerId}
                    .tw-coffee-cup::before,
                    #${this.config.containerId}
                    .tw-coffee-cup::after {
                        animation: none;
                        opacity: 0;
                    }

                    #${this.config.containerId}
                    .tw-coffee-fill {
                        animation: none;
                        transform: scaleY(0.8);
                    }

                    #${this.config.containerId}
                    .tw-coffee-label > span {
                        animation: none;
                        opacity: 0;
                        filter: none;
                        transform: none;
                    }

                    #${this.config.containerId}
                    .tw-coffee-label
                    > span:nth-child(2) {
                        opacity: 1;
                    }

                    #${this.config.containerId}
                    .tw-bmc::after {
                        animation: none;
                        opacity: 0;
                    }
                }

                /* =================================================
                 * MOBILE / TORN PDA
                 * ================================================= */

                @media (max-width: 480px) {
                    #${this.config.containerId} {
                        width: 100%;
                    }

                    #${this.config.containerId}
                    .tw-support-btn {
                        width: 100%;
                    }

                    #${this.config.containerId}
                    .tw-bmc {
                        min-width: 0;
                    }
                }
            `;

            /*
             * Preferred Tampermonkey path.
             *
             * Some restricted WebViews can expose GM_addStyle but
             * still throw when it is called. Fall back safely.
             */
            if (typeof GM_addStyle === "function") {
                try {
                    const created = GM_addStyle(styles);
                    const node = created && created.nodeType === 1 ? created :
                        Array.from(document.querySelectorAll("style")).find(item => item.textContent === styles);
                    if (node) { node.id = this.config.styleId; return; }
                } catch (_) {
                    /*
                     * Fall through to normal DOM style injection.
                     */
                }
            }

            this.injectStyleElement(styles);
        }

        injectStyleElement(styles) {
            if (document.getElementById(this.config.styleId)) {
                return;
            }

            const styleNode =
                document.createElement("style");

            styleNode.id =
                this.config.styleId;

            styleNode.type =
                "text/css";

            styleNode.textContent =
                styles;

            if (document.head) {
                document.head.appendChild(styleNode);
                return;
            }

            const body = this.getBody();

            if (body) {
                body.appendChild(styleNode);
            }
        }

        /* ========================================================
         * COFFEE BUTTON
         * ======================================================== */

        buildCoffeeButton() {
            coffeeInstanceCount += 1;

            const clipId =
                `${this.config.containerId}-coffee-clip-${coffeeInstanceCount}`;

            const bmcLink =
                document.createElement("a");

            bmcLink.className =
                "tw-support-btn tw-bmc";

            bmcLink.href =
                `https://www.buymeacoffee.com/${encodeURIComponent(
                    this.config.bmcId
                )}`;

            bmcLink.target = "_blank";

            bmcLink.rel =
                "noopener noreferrer";

            bmcLink.title =
                "Support ThaWookie";

            bmcLink.setAttribute(
                "aria-label",
                "Buy me a coffee : support ThaWookie"
            );

            /*
             * ----------------------------------------------------
             * Animated coffee cup
             * ----------------------------------------------------
             */

            const cup =
                document.createElement("span");

            cup.className =
                "tw-coffee-cup";

            cup.setAttribute(
                "aria-hidden",
                "true"
            );

            const svg =
                document.createElementNS(
                    "http://www.w3.org/2000/svg",
                    "svg"
                );

            svg.setAttribute(
                "width",
                "16"
            );

            svg.setAttribute(
                "height",
                "16"
            );

            svg.setAttribute(
                "viewBox",
                "0 0 24 24"
            );

            svg.setAttribute(
                "fill",
                "none"
            );

            svg.setAttribute(
                "stroke",
                "currentColor"
            );

            svg.setAttribute(
                "stroke-width",
                "1.5"
            );

            svg.setAttribute(
                "aria-hidden",
                "true"
            );

            /*
             * SVG clip path.
             *
             * This is intentionally generated through DOM APIs
             * rather than innerHTML so the only dynamic value,
             * clipId, cannot become an HTML injection vector.
             */

            const defs =
                document.createElementNS(
                    "http://www.w3.org/2000/svg",
                    "defs"
                );

            const clipPath =
                document.createElementNS(
                    "http://www.w3.org/2000/svg",
                    "clipPath"
                );

            clipPath.setAttribute(
                "id",
                clipId
            );

            const clipShape =
                document.createElementNS(
                    "http://www.w3.org/2000/svg",
                    "path"
                );

            clipShape.setAttribute(
                "d",
                "M5 8h11v5a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V8z"
            );

            clipPath.appendChild(
                clipShape
            );

            defs.appendChild(
                clipPath
            );

            svg.appendChild(
                defs
            );

            /*
             * Coffee liquid.
             *
             * The CSS transform animation controls its visible
             * fill level.
             */
            const coffeeFill =
                document.createElementNS(
                    "http://www.w3.org/2000/svg",
                    "rect"
                );

            coffeeFill.setAttribute(
                "class",
                "tw-coffee-fill"
            );

            coffeeFill.setAttribute(
                "x",
                "5"
            );

            coffeeFill.setAttribute(
                "y",
                "8"
            );

            coffeeFill.setAttribute(
                "width",
                "11"
            );

            coffeeFill.setAttribute(
                "height",
                "9"
            );

            coffeeFill.setAttribute(
                "fill",
                "#6f4e37"
            );

            coffeeFill.setAttribute(
                "stroke",
                "none"
            );

            coffeeFill.setAttribute(
                "clip-path",
                `url(#${clipId})`
            );

            svg.appendChild(
                coffeeFill
            );

            /*
             * Cup body outline.
             */
            const cupBody =
                document.createElementNS(
                    "http://www.w3.org/2000/svg",
                    "path"
                );

            cupBody.setAttribute(
                "stroke-linecap",
                "round"
            );

            cupBody.setAttribute(
                "stroke-linejoin",
                "round"
            );

            cupBody.setAttribute(
                "d",
                "M5 8h11v5a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V8z"
            );

            svg.appendChild(
                cupBody
            );

            /*
             * Cup handle.
             */
            const cupHandle =
                document.createElementNS(
                    "http://www.w3.org/2000/svg",
                    "path"
                );

            cupHandle.setAttribute(
                "stroke-linecap",
                "round"
            );

            cupHandle.setAttribute(
                "stroke-linejoin",
                "round"
            );

            cupHandle.setAttribute(
                "d",
                "M16 9h2.5a2.5 2.5 0 0 1 0 5H16"
            );

            svg.appendChild(
                cupHandle
            );

            cup.appendChild(
                svg
            );

            bmcLink.appendChild(
                cup
            );

            /*
             * ----------------------------------------------------
             * Animated label
             * ----------------------------------------------------
             */

            const label =
                document.createElement("span");

            label.className =
                "tw-coffee-label";

            label.setAttribute(
                "aria-hidden",
                "true"
            );

            const supportLabel =
                document.createElement("span");

            supportLabel.textContent =
                "Support the project?";

            const coffeeLabel =
                document.createElement("span");

            coffeeLabel.textContent =
                "Buy me a coffee";

            label.appendChild(
                supportLabel
            );

            label.appendChild(
                coffeeLabel
            );

            bmcLink.appendChild(
                label
            );

            return bmcLink;
        }

        /* ========================================================
         * UI INJECTION
         * ======================================================== */

        injectUI() {
            if (
                this.destroyed ||
                this.isInjecting
            ) {
                return;
            }

            const body = this.host || this.getBody();

            if (!body || !body.isConnected) {
                return;
            }

            if (this.isContainerConnected()) {
                return;
            }

            this.isInjecting = true;

            try {
                /*
                 * Remove stale disconnected node, if present.
                 */
                const existingContainer =
                    this.getContainer();

                if (existingContainer) {
                    existingContainer.remove();
                }

                const container =
                    document.createElement("div");

                container.id =
                    this.config.containerId;

                container.setAttribute(
                    "role",
                    "complementary"
                );

                container.setAttribute(
                    "aria-label",
                    "Support ThaWookie"
                );

                /*
                 * Animated Buy Me a Coffee button.
                 */
                const bmcLink =
                    this.buildCoffeeButton();

                /*
                 * ------------------------------------------------
                 * Torn Xanax Tip
                 * ------------------------------------------------
                 */

                const tipLink =
                    document.createElement("a");

                tipLink.href =
                    "https://www.torn.com/item.php";

                tipLink.target =
                    "_blank";

                tipLink.rel =
                    "noopener noreferrer";

                tipLink.className =
                    "tw-support-btn tw-torn-tip";

                tipLink.title =
                    `Opens Items : search "Xanax", ` +
                    `tap Send, enter ThaWookie ` +
                    `[${this.config.tornUserId}]`;

                tipLink.setAttribute(
                    "aria-label",
                    `Send a Xanax tip to ThaWookie ` +
                    `[${this.config.tornUserId}]`
                );

                tipLink.textContent =
                    "💊 Send a Xanax Tip";

                /*
                 * Assemble donation controls.
                 */
                container.appendChild(
                    bmcLink
                );

                container.appendChild(
                    tipLink
                );

                /*
                 * Mount inside the host userscript's settings section.
                 * The host restores that section if Torn removes it.
                 */
                body.appendChild(
                    container
                );
            } finally {
                this.isInjecting = false;
            }
        }

        /* ========================================================
         * MUTATION OBSERVER
         * ======================================================== */

        attachObserver() {
            if (this.destroyed || this.observerAttached ||
                typeof MutationObserver === "undefined") return;
            const host = this.host || this.getBody();
            if (!host) return;
            this.observer = new MutationObserver(() => {
                if (this.destroyed || this.isInjecting || !host.isConnected) return;
                if (!document.getElementById(this.config.styleId)) this.injectStyles();
                if (!this.isContainerConnected()) this.injectUI();
            });
            // Only the module mount and style parent, not Torn's React subtree.
            this.observer.observe(host, { childList: true });
            if (document.head) this.observer.observe(document.head, { childList: true });
            this.observerAttached = true;
        }

        /* ========================================================
         * CLEANUP
         * ======================================================== */

        destroy() {
            this.destroyed = true;

            if (this.observer) {
                try {
                    this.observer.disconnect();
                } catch (_) {
                    /*
                     * Nothing further required.
                     */
                }
            }

            this.observer = null;
            this.observerAttached = false;

            const container =
                this.getContainer();

            if (container) {
                container.remove();
            }
            const style = document.getElementById(this.config.styleId);
            if (style) style.remove();
        }
    }

    /* Embedded debugger, retaining the supplied inspector and log engine. */
/**
 * File: userscript-debugger-module.js
 * Version: 1.0.5 (clipboard compatibility fix of supplied v1.0.4)
 * Advanced Modular Userscript Debugger with optional DOM Inspector
 * Author: ShavedW00kie (Torn: ThaWookie [2954173] )
 * Namespace: https://github.com/ShavedW00kie/
 * Target: Embedded inside a Torn.com userscript IIFE (desktop and TornPDA).
 * License: BSD-3-Clause
 *
 * Copyright (c) 2026 ShavedW00kie
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 * 1. Redistributions of source code must retain the above copyright notice,
 *    this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the documentation
 *    and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software
 *    without specific prior written permission.
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
 *
 * Integration inside the host userscript's IIFE, AFTER this function definition:
 *   const MyDebug = initializeModularDebugger(GM_info.script.name);
 *   MyDebug.log("Ready");
 *   bugButton.addEventListener("click", () => MyDebug.toggleView());
 *   copyButton.addEventListener("click", function () { void MyDebug.copy(this); });
 *   // Optional: MyDebug.inspect(), MyDebug.inspectElement(element),
 *   // MyDebug.watchElement(element), MyDebug.stopInspection(), MyDebug.destroy().
 *
 * This file is a source module, not an independently installable userscript.
 * The host userscript supplies its own ==UserScript== metadata and IIFE.
 */
function initializeModularDebugger(scriptNamespace) {
    "use strict";
    if (scriptNamespace === undefined) scriptNamespace = "App";

    const randomId = (() => {
        try {
            if (typeof crypto !== "undefined" && crypto.randomUUID) {
                return crypto.randomUUID().replace(/-/g, "");
            }
        } catch (_) { /* WebView fallback. */ }
        return Math.random().toString(36).slice(2) + Date.now().toString(36);
    })();
    const id = `tw-debug-${randomId}`;
    const LIMITS = Object.freeze({
        buffer: (10 * 1024 * 1024) - (900 * 1024),
        entry: 64 * 1024,
        renderEntries: 180,
        renderChars: 128 * 1024,
        report: 15000,
        html: 6000,
        parents: 6,
        children: 12,
        nodes: 65,
        mutations: 40
    });
    const state = {
        logs: [], head: 0, length: 0, destroyed: false, 
        frames: new Set(), statuses: new Map(), resizeObserver: null,
        root: null, logArea: null, inspector: null, inspectorText: null,
        style: null, statusBar: null, highlight: null,
        panelMode: "logs", selected: null, picking: false,
        watching: false, changeLog: [],
        observer: null, parentObserver: null, uiObserver: null,
        observedBody: null, renderPending: false,
        pendingMutations: 0, mutationLogPending: false,
        viewportListeners: false, highlightPending: false
    };
    const SENSITIVE = /(?:^key$|api[_-]?key|apikey|token|auth|authorization|cookie|secret|passwd|password|csrf|session|bearer|credential|client[_-]?secret|refresh[_-]?token|access[_-]?token)/i;
    const SAFE_ATTRIBUTES = new Set([
        "id", "class", "role", "type", "aria-expanded",
        "aria-hidden", "data-testid", "data-test", "data-role", "data-state"
    ]);

    /* ---------- Redacted, bounded logging ---------- */
    function redact(value) {
        return String(value)
            .replace(/\b(?:Authorization|Proxy-Authorization)\s*:\s*[^\r\n]+/gi, "Authorization: [REDACTED]")
            .replace(/\b[A-Za-z0-9]{16}\b/g, "[POSSIBLE KEY REDACTED]")
            // Bearer tokens and known secret-bearing URL parameters.
            .replace(/(\bBearer\s+)[A-Za-z0-9._~+/-]+/gi, "$1[REDACTED]")
            .replace(/([?&](?:key|api_key|token|access_token|refresh_token|secret|session|csrf)=)[^&#\s\"'<>}\]]+/gi, "$1[REDACTED]")
            // Quoted property values, including embedded spaces.
            .replace(/(["']?(?:api[_-]?key|apikey|token|authorization|cookie|password|passwd|secret|csrf|session|access[_-]?token|refresh[_-]?token)["']?\s*[:=]\s*)(["'])([^"']*)\2/gi,
                (_, prefix, quote) => `${prefix}${quote}[REDACTED]${quote}`)
            // Unquoted key=value patterns.
            .replace(/(["']?(?:api[_-]?key|apikey|token|authorization|cookie|password|passwd|secret|csrf|session|access[_-]?token|refresh[_-]?token)["']?\s*[:=]\s*)(?!["'])([^\s"',;}&\]]+)/gi,
                (_, prefix) => `${prefix}[REDACTED]`);
    }

    // Does not call getters or toJSON. Proxies can still execute traps; never
    // deliberately pass hostile proxies to an in-process diagnostic function.
    function safeSerialize(value) {
        let remaining = 240;
        const path = new WeakSet();
        function visit(item, depth) {
            if (--remaining < 0) return "[Traversal limit]";
            if (typeof item === "string") return redact(item.slice(0, 8192));
            if (item === null || typeof item === "boolean" || typeof item === "number") return item;
            if (typeof item === "undefined") return "[undefined]";
            if (typeof item === "bigint" || typeof item === "symbol") return String(item);
            if (typeof item === "function") return "[Function]";
            if (path.has(item)) return "[Circular]";
            if (depth >= 5) return "[Depth limit]";
            path.add(item);
            try {
                const result = Object.create(null);
                let count = 0;
                if (item instanceof Error) {
                    for (const key of ["name", "message", "stack"]) {
                        const descriptor = Object.getOwnPropertyDescriptor(item, key);
                        result[key] = descriptor && "value" in descriptor
                            ? visit(descriptor.value, depth + 1) : "[Unavailable/accessor]";
                    }
                }
                // for-in permits early exit without allocating Object.keys for
                // every property. Reflection itself is not a hard time limit.
                for (const key in item) {
                    if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
                    if (++count > 40 || remaining <= 0) { result["[Truncated]"] = true; break; }
                    const descriptor = Object.getOwnPropertyDescriptor(item, key);
                    result[redact(key.slice(0, 160))] = SENSITIVE.test(key) ? "[REDACTED]"
                        : descriptor && "value" in descriptor ? visit(descriptor.value, depth + 1) : "[Accessor omitted]";
                }
                return result;
            } catch (_) { return "[Unserializable]"; }
            finally { path.delete(item); }
        }
        try {
            if (typeof value === "string") return redact(value.slice(0, LIMITS.entry));
            return JSON.stringify(visit(value, 0));
        } catch (_) { return "[Unserializable]"; }
    }
    function scheduleFrame(callback) {
        if (state.destroyed) return;
        if (typeof requestAnimationFrame !== "function") { callback(); return; }
        const handle = requestAnimationFrame(() => {
            state.frames.delete(handle);
            if (!state.destroyed) callback();
        });
        state.frames.add(handle);
    }
    function trim(text, max) {
        text = String(text);
        return text.length > max ? `${text.slice(0, Math.max(0, max - 17))}[TRUNCATED]` : text;
    }
    function log(message, level = "INFO") {
        if (state.destroyed) return;
        const label = typeof level === "string" && /^(INFO|WARN|ERROR|DEBUG)$/i.test(level) ? level.toUpperCase() : "INFO";
        const timestamp = new Date().toISOString();
        const entry = trim(`[${timestamp}] [${label}] ${safeSerialize(message)}`, LIMITS.entry);
        const size = entry.length + 1;
        while (state.head < state.logs.length && state.length + size > LIMITS.buffer) {
            state.length -= state.logs[state.head].length + 1;
            state.logs[state.head++] = null; // Release pruned strings immediately.
        }
        if (state.head > 2048) { state.logs = state.logs.slice(state.head); state.head = 0; }
        state.logs.push(entry);
        state.length += size;
        queueRender();
    }
    const info = message => log(message, "INFO");
    const warn = message => log(message, "WARN");
    const error = message => log(message, "ERROR");
    function clear() {
        state.logs.length = 0;
        state.head = 0;
        state.length = 0;
        renderLogs();
    }
    function queueRender() {
        if (!state.logArea || !state.root || state.root.hidden || state.panelMode !== "logs") return;
        if (state.renderPending) return;
        state.renderPending = true;
        scheduleFrame(() => { state.renderPending = false; renderLogs(); });
    }
    function renderLogs() {
        if (state.destroyed || !state.root || state.root.hidden || !state.logArea || !state.logArea.isConnected || state.panelMode !== "logs") return;
        const subset = [];
        let chars = 0;
        for (let i = state.logs.length - 1; i >= state.head && subset.length < LIMITS.renderEntries; i--) {
            if (chars + state.logs[i].length + 1 > LIMITS.renderChars) break;
            subset.unshift(state.logs[i]); chars += state.logs[i].length + 1;
        }
        const skipped = state.logs.length - state.head - subset.length;
        state.logArea.textContent = (skipped ? `[${skipped} earlier entries retained for copying]\n` : "") + subset.join("\n");
        state.logArea.scrollTop = state.logArea.scrollHeight;
    }

    /* ---------- Clipboard (Tampermonkey, TornPDA, browser) ---------- */
    function copyFallback(text) {
        if (!document.body) return false;
        const input = document.createElement("textarea");
        const previousFocus = document.activeElement;
        const selection = typeof window.getSelection === "function" ? window.getSelection() : null;
        const ranges = [];
        if (selection) for (let i = 0; i < selection.rangeCount; i++) ranges.push(selection.getRangeAt(i).cloneRange());
        let caret = null;
        try { if (previousFocus && typeof previousFocus.selectionStart === "number") caret = [previousFocus.selectionStart, previousFocus.selectionEnd, previousFocus.selectionDirection]; } catch (_) {}
        input.value = text;
        input.readOnly = true;
        input.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;z-index:-1";
        try {
            document.body.appendChild(input);
            input.focus();
            input.select();
            input.setSelectionRange(0, text.length);
            return Boolean(document.execCommand("copy"));
        } catch (_) { return false; }
        finally {
            input.remove();
            try { if (previousFocus && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
                if (caret) previousFocus.setSelectionRange(...caret);
                if (selection) { selection.removeAllRanges(); ranges.forEach(range => selection.addRange(range)); } } catch (_) { /* Non-focusable element. */ }
        }
    }
    async function writeClipboard(text) {
        const pdaShim = typeof GM_info !== "undefined" && GM_info &&
            /GMforPDA/i.test(String(GM_info.scriptHandler || ""));
        // GMforPDA's clipboard wrapper does not return its browser Promise.
        // Await the browser API directly so rejection reaches our fallback.
        if (!pdaShim) {
            try {
                if (typeof GM_setClipboard === "function") {
                    await Promise.resolve(GM_setClipboard(text, "text"));
                    return true;
                }
            } catch (_) { /* Try the Promise-based manager API. */ }
            try {
                if (typeof GM !== "undefined" && GM && typeof GM.setClipboard === "function") {
                    await GM.setClipboard(text, "text");
                    return true;
                }
            } catch (_) { /* Try browser APIs. */ }
        }
        if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
            try { await navigator.clipboard.writeText(text); return true; }
            catch (_) { /* Restricted WebView. */ }
        }
        return copyFallback(text);
    }
    function showCopyResult(button, result) {
        if (state.destroyed || !button || !button.isConnected) return;
        let saved = state.statuses.get(button);
        if (saved) clearTimeout(saved.timer);
        else saved = { nodes: Array.from(button.childNodes), timer: null };
        button.textContent = result;
        // This timer is only UI feedback, never element discovery or polling.
        saved.timer = setTimeout(() => {
            button.replaceChildren(...saved.nodes);
            state.statuses.delete(button);
        }, 1300);
        state.statuses.set(button, saved);
    }
    async function copy(button = null) {
        if (state.destroyed) return false;
        const text = state.logs.slice(state.head).join("\n");
        if (!text) { showCopyResult(button, "Empty"); return false; }
        const success = await writeClipboard(text);
        showCopyResult(button, success ? "Copied!" : "Failed");
        if (!success) warn("Clipboard unavailable. Open debugger to select and copy manually.");
        return success;
    }

    /* ---------- Safe DOM descriptions ---------- */
    function isElement(node) { return Boolean(node && node.nodeType === 1 && node.tagName); }
    function tag(node) { return isElement(node) ? node.tagName.toLowerCase() : "(none)"; }
    function describe(node) {
        if (!isElement(node)) return "(none)";
        let text = tag(node);
        const nodeId = node.getAttribute("id");
        if (nodeId && !SENSITIVE.test(nodeId)) text += `#${trim(redact(nodeId), 50)}`;
        const classes = Array.from(node.classList || []).filter(name => !SENSITIVE.test(name)).slice(0, 3);
        if (classes.length) text += "." + classes.map(name => trim(redact(name), 48)).join(".");
        return trim(text, 180);
    }
    function selectorSegment(node) {
        if (!isElement(node)) return "";
        const nodeId = node.getAttribute("id");
        if (nodeId && /^[A-Za-z_][\w-]{0,60}$/.test(nodeId) && !SENSITIVE.test(nodeId)) {
            return `#${nodeId}`;
        }
        let part = tag(node);
        const classNames = Array.from(node.classList || [])
            .filter(name => /^[A-Za-z_][\w-]{0,45}$/.test(name) && !SENSITIVE.test(name))
            .slice(0, 2);
        part += classNames.map(name => `.${name}`).join("");
        if (node.parentElement) {
            const same = Array.from(node.parentElement.children).filter(sibling => sibling.tagName === node.tagName);
            if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
        }
        return part;
    }
    function makeSelector(element) {
        const segments = [];
        let current = element;
        for (let step = 0; step < LIMITS.parents && isElement(current); step++) {
            const segment = selectorSegment(current);
            segments.unshift(segment);
            if (segment.startsWith("#")) break;
            current = current.parentElement;
        }
        const selector = segments.join(" > ");
        if (selector.length > 500) return "(selector exceeds safe length)";
        if (redact(selector) !== selector) return "(selector omitted: possible credential)";
        return selector;
    }
    function safeAttributeText(element) {
        const result = [];
        if (!isElement(element)) return "";
        for (const attr of Array.from(element.attributes || [])) {
            if (!SAFE_ATTRIBUTES.has(attr.name) || SENSITIVE.test(attr.name)) continue;
            if (SENSITIVE.test(attr.value)) continue;
            result.push(`${attr.name}="${escapeHTML(trim(redact(attr.value), 90))}"`);
            if (result.length >= 8) break;
        }
        return result.length ? ` ${result.join(" ")}` : "";
    }
    function escapeHTML(value) {
        return String(value).replace(/[&<>"']/g, character => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
        })[character]);
    }
    function structuralHTML(element) {
        let budget = LIMITS.nodes;
        const skip = /^(script|style|noscript|template|iframe|object|embed)$/i;
        function recurse(node, depth) {
            if (!isElement(node) || budget-- <= 0) return "";
            const name = tag(node);
            const open = `<${name}${safeAttributeText(node)}>`;
            if (skip.test(name)) return `${open}[contents omitted]</${name}>`;
            if (depth >= 2) return `${open}[descendants omitted]</${name}>`;
            const kids = Array.from(node.children).slice(0, LIMITS.children);
            const nested = kids.map(child => recurse(child, depth + 1)).join("\n");
            const note = node.children.length > LIMITS.children ? "\n[additional children omitted]" : "";
            return `${open}${nested ? `\n${nested}${note}\n` : "[text omitted]"}</${name}>`;
        }
        return trim(recurse(element, 0), LIMITS.html);
    }
    function reactRootHint(element) {
        let node = element;
        for (let i = 0; i < LIMITS.parents && isElement(node); i++, node = node.parentElement) {
            const candidateId = node.getAttribute("id") || "";
            if (/^(?:react-root|root|__next)$/i.test(candidateId) || node.hasAttribute("data-reactroot")) {
                return `${describe(node)} (heuristic only)`;
            }
        }
        return "Not detected (does not rule out React)";
    }
    function getInspectionReport() {
        const element = state.selected;
        if (!isElement(element)) return "No element selected.";
        const ancestors = [];
        let ancestor = element.parentElement;
        for (let i = 0; i < LIMITS.parents && isElement(ancestor); i++, ancestor = ancestor.parentElement) {
            ancestors.push(`  ${i + 1}. ${describe(ancestor)}`);
        }
        const children = Array.from(element.children).slice(0, LIMITS.children)
            .map((child, index) => `  ${index + 1}. ${describe(child)}`);
        const page = typeof location !== "undefined"
            ? (location.origin === "null" ? "(local document)" : `${location.origin}${location.pathname}`)
            : "(unknown)";
        return trim(redact([
            `DOM INSPECTION | ${redact(String(scriptNamespace))}`,
            `Time: ${new Date().toISOString()}`,
            `Page (query omitted): ${redact(page)}`,
            `Selected: ${describe(element)}`,
            `Connected: ${element.isConnected}`,
            `Selector (best effort): ${makeSelector(element)}`,
            `React container hint: ${reactRootHint(element)}`,
            `Parent chain:\n${ancestors.join("\n") || "  (none)"}`,
            `Immediate children (${element.children.length}):\n${children.join("\n") || "  (none)"}`,
            `Sibling context: previous=${describe(element.previousElementSibling)}, next=${describe(element.nextElementSibling)}`,
            `Structural preview (text nodes, form values, URLs and scripts omitted; review attributes before sharing):\n${structuralHTML(element)}`,
            `Recent observed mutations (${state.changeLog.length}):\n${state.changeLog.join("\n") || "  (none)"}`
        ].join("\n\n")), LIMITS.report);
    }

    /* ---------- On-demand DOM selection and mutation watch ---------- */
    function isOurUI(node) {
        return Boolean(isElement(node) && (
            (state.root && state.root.contains(node)) ||
            (state.highlight && state.highlight.contains(node))
        ));
    }
    function ensureHighlight() {
        if (state.destroyed || !state.selected || !state.root || state.root.hidden || state.panelMode !== "inspect") return null;
        if (state.highlight && state.highlight.isConnected) return state.highlight;
        if (!document.body) return null;
        const node = document.createElement("div");
        node.setAttribute("aria-hidden", "true");
        node.style.cssText = "position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #00dbff;box-shadow:0 0 0 1px #001e28;box-sizing:border-box;display:none";
        document.body.appendChild(node);
        state.highlight = node;
        return node;
    }
    function updateHighlight() {
        const marker = ensureHighlight();
        if (!marker) return;
        const node = state.selected;
        if (!isElement(node) || !node.isConnected || !state.root || state.root.hidden || state.panelMode !== "inspect") {
            marker.style.display = "none";
            return;
        }
        const rect = node.getBoundingClientRect();
        marker.style.display = "block";
        marker.style.top = `${rect.top}px`;
        marker.style.left = `${rect.left}px`;
        marker.style.width = `${rect.width}px`;
        marker.style.height = `${rect.height}px`;
    }
    function onViewportChanged() {
        if (state.destroyed || !state.selected || state.highlightPending || state.panelMode !== "inspect") return;
        state.highlightPending = true;
        scheduleFrame(() => {
            state.highlightPending = false;
            updateHighlight();
        });
    }
    function setViewportListeners(enable) {
        if (typeof window === "undefined" || enable === state.viewportListeners) return;
        state.viewportListeners = enable;
        const method = enable ? "addEventListener" : "removeEventListener";
        window[method]("scroll", onViewportChanged, true);
        window[method]("resize", onViewportChanged);
    }
    function removeHighlight() {
        if (state.highlight) { state.highlight.remove(); state.highlight = null; }
    }
    function updateInspector() {
        if (!state.inspectorText) return;
        state.inspectorText.textContent = state.selected ? trim([
            `Selected: ${describe(state.selected)}`,
            `Parent: ${describe(state.selected.parentElement)}`,
            `Children: ${state.selected.children.length}`,
            `Selector: ${makeSelector(state.selected)}`,
            `Connected: ${state.selected.isConnected}`,
            `Watch: ${state.watching ? "ON" : "OFF"} | Changes: ${state.changeLog.length}`
        ].join("\n"), 1100) : "Tap Pick, then tap a Torn page element.\nNo page data is collected until inspection is used.";
        if (state.statusBar) state.statusBar.textContent = state.picking ? "PICK MODE: tap a page element or press Esc" : "Inspector idle";
        updateHighlight();
    }
    function suppressPickAction(event) {
        if (isOurUI(event.target)) return;
        event.stopImmediatePropagation();
        // Preserve the browser synthetic click needed for tap selection.
    }
    function onPickClick(event) {
        if (isOurUI(event.target)) return;
        // Capture before Torn/React click handlers so selecting a link does not navigate.
        event.preventDefault();
        event.stopImmediatePropagation();
        if (isElement(event.target)) inspectElement(event.target);
        stopPicker();
    }
    function onPickKey(event) {
        if (event.key === "Escape") {
            event.preventDefault();
            stopPicker();
            updateInspector();
        }
    }
    function startPicker() {
        if (state.destroyed || !state.root || !state.root.isConnected || state.root.hidden || state.picking) return;
        state.picking = true;
        document.addEventListener("click", onPickClick, true);
        ["pointerdown", "pointerup", "touchstart", "touchend", "mousedown", "mouseup"].forEach(type => document.addEventListener(type, suppressPickAction, { capture: true, passive: false }));
        document.addEventListener("keydown", onPickKey, true);
        updateInspector();
    }
    function stopPicker() {
        if (!state.picking) return;
        state.picking = false;
        document.removeEventListener("click", onPickClick, true);
        ["pointerdown", "pointerup", "touchstart", "touchend", "mousedown", "mouseup"].forEach(type => document.removeEventListener(type, suppressPickAction, true));
        document.removeEventListener("keydown", onPickKey, true);
        updateInspector();
    }
    function stopWatch() {
        if (state.observer) state.observer.disconnect();
        if (state.parentObserver) state.parentObserver.disconnect();
        state.observer = null;
        state.parentObserver = null;
        state.watching = false;
        state.pendingMutations = 0;
        updateInspector();
    }
    function handleMutations(mutations) {
        if (!state.watching) return;
        const stamp = new Date().toISOString();
        let changed = 0;
        for (const mutation of mutations) {
            if (changed >= 8) break;
            const detail = mutation.type === "characterData" ? "text node changed (content omitted)" : mutation.type === "attributes"
                ? `attribute ${mutation.attributeName} on ${describe(mutation.target)}`
                : `childList (+${mutation.addedNodes.length}/-${mutation.removedNodes.length}) on ${describe(mutation.target)}`;
            state.changeLog.push(`[${stamp}] ${detail}`);
            changed++;
        }
        while (state.changeLog.length > LIMITS.mutations) state.changeLog.shift();
        if (changed) {
            state.pendingMutations += changed;
            if (!state.mutationLogPending) {
                state.mutationLogPending = true;
                scheduleFrame(() => {
                    state.mutationLogPending = false;
                    const count = state.pendingMutations;
                    state.pendingMutations = 0;
                    if (count && state.watching) log(`DOM watch: ${count} sampled change(s) near ${describe(state.selected)}`, "DEBUG");
                });
            }
        }
        if (state.selected && !state.selected.isConnected) {
            warn(`DOM watch: selected element detached: ${describe(state.selected)}`);
            stopWatch();
        }
        updateInspector();
    }
    function watchElement(element = state.selected) {
        if (state.destroyed || !isElement(element) || !element.isConnected || element === document.documentElement || element === document.body) {
            warn("DOM watch requires a specific element, not the document root/body.");
            return false;
        }
        if (typeof MutationObserver === "undefined") {
            warn("MutationObserver is unavailable in this WebView.");
            return false;
        }
        stopWatch();
        if (element !== state.selected && !inspectElement(element)) return false;
        state.changeLog.length = 0;
        // Observe the chosen subtree and direct child lists along its ancestor chain.
        state.observer = new MutationObserver(handleMutations);
        state.observer.observe(element, {
            attributes: true, childList: true, characterData: true, subtree: true,
            attributeFilter: ["class", "id", "role", "aria-expanded", "hidden", "disabled", "data-state"]
        });
        if (element.parentElement) {
            state.parentObserver = new MutationObserver(handleMutations);
            let ancestor = element.parentElement;
            while (ancestor) {
                state.parentObserver.observe(ancestor, { childList: true });
                ancestor = ancestor.parentNode;
            }
        }
        state.watching = true;
        info(`DOM watch enabled: ${describe(element)}`);
        updateInspector();
        return true;
    }
    function moveSelection(direction) {
        const selected = state.selected;
        if (!isElement(selected)) return;
        const next = direction === "parent" ? selected.parentElement : selected.firstElementChild;
        if (next && next !== document.body && next !== document.documentElement) inspectElement(next);
    }
    function inspectElement(element) {
        if (state.destroyed || !isElement(element) || isOurUI(element) || !ensureUI()) return false;
        if (state.watching && state.selected !== element) stopWatch();
        state.selected = element;
        if (state.resizeObserver) state.resizeObserver.disconnect();
        if (typeof ResizeObserver === "function") {
            state.resizeObserver = new ResizeObserver(onViewportChanged);
            state.resizeObserver.observe(element);
        }
        state.changeLog.length = 0;
        showPanel("inspect");
        updateInspector();
        info(`DOM selected: ${describe(element)} | ${makeSelector(element)}`);
        return true;
    }
    function inspect() {
        if (!showPanel("inspect")) return false;
        startPicker();
        return true;
    }
    function stopInspection() {
        stopPicker();
        stopWatch();
        state.selected = null;
        if (state.resizeObserver) state.resizeObserver.disconnect();
        state.resizeObserver = null;
        state.changeLog.length = 0;
        removeHighlight();
        setViewportListeners(false);
        if (state.root && !state.root.hidden) showPanel("logs");
    }
    async function copyInspection(button = null) {
        if (state.destroyed) return false;
        if (!state.selected) { showCopyResult(button, "No selection"); return false; }
        const result = await writeClipboard(getInspectionReport());
        showCopyResult(button, result ? "Copied!" : "Failed");
        return result;
    }

    /* ---------- Compact UI, created on first use ---------- */
    function createButton(text, label, handler) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = text;
        button.title = label;
        button.setAttribute("aria-label", label);
        button.className = `${id}-btn`;
        button.addEventListener("click", handler);
        return button;
    }
    function ensureStyles() {
        if (state.destroyed) return;
        if (state.style && state.style.isConnected) return;
        if (!document.head && !document.body) return;
        const style = document.createElement("style");
        style.id = `${id}-styles`;
        style.textContent = `
          @keyframes ${id}-reset {from{opacity:.7}to{opacity:1}}
          .${id}-flash{animation:${id}-reset 1.3s ease 1}
          #${id}{position:fixed;right:12px;bottom:12px;width:min(430px,calc(100vw - 24px));
            height:320px;max-height:70vh;display:flex;flex-direction:column;gap:8px;padding:10px;
            background:#191919;color:#e2ffe7;border:1px solid #46db85;border-radius:8px;
            box-shadow:0 6px 25px #0009;box-sizing:border-box;font:12px/1.45 monospace;
            z-index:2147483647;touch-action:manipulation}
          #${id}[hidden],#${id} [hidden]{display:none!important}
          #${id} button{font:11px/1.2 sans-serif;min-height:30px;cursor:pointer}
          #${id} .${id}-btn{border:1px solid #616161;border-radius:4px;background:#292929;
            color:#fff;padding:6px;touch-action:manipulation}
          #${id} .${id}-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:4px}
          #${id} .${id}-title{font-weight:bold;flex:1 1 120px;min-width:0;overflow:hidden;text-overflow:ellipsis}
          #${id} .${id}-body{flex:1;min-height:0;overflow:auto;white-space:pre-wrap;
            overflow-wrap:anywhere;user-select:text}
          #${id} .${id}-actions{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:5px}
          #${id} .${id}-status{font-size:11px;color:#ace3fc}
          #${id} button:focus-visible{outline:2px solid #91dfff;outline-offset:2px}
          @media(max-width:480px){#${id}{right:8px;bottom:8px;width:calc(100vw - 16px);
            height:290px;font-size:11px}}
          @media(prefers-reduced-motion:reduce){.${id}-flash{animation:none}}
        `;
        (document.head || document.body).appendChild(style);
        state.style = style;
    }
    function ensureUI() {
        if (state.destroyed) return false;
        if (state.root && state.root.isConnected) { ensureStyles(); return true; }
        if (!document.body) return false;
        ensureStyles();
        const root = document.createElement("section");
        root.id = id;
        root.hidden = true;
        root.setAttribute("aria-label", `Debug console: ${String(scriptNamespace)}`);
        const toolbar = document.createElement("div");
        toolbar.className = `${id}-toolbar`;
        const title = document.createElement("span");
        title.className = `${id}-title`;
        title.textContent = `🪲 ${String(scriptNamespace)}`;
        toolbar.append(title,
            createButton("Copy", "Copy logs", function () { void copy(this); }),
            createButton("Clear", "Clear logs", clear),
            createButton("🔍", "Inspect Torn DOM element", inspect),
            createButton("Hide", "Hide debugger", () => toggleView()));
        const logArea = document.createElement("pre");
        logArea.className = `${id}-body`;
        logArea.style.margin = "0";
        const inspector = document.createElement("div");
        inspector.className = `${id}-body`;
        inspector.hidden = true;
        const actions = document.createElement("div");
        actions.className = `${id}-actions`;
        actions.append(
            createButton("Pick", "Pick element by tapping it", startPicker),
            createButton("↑ Parent", "Inspect parent element", () => moveSelection("parent")),
            createButton("↓ Child", "Inspect first child element", () => moveSelection("child")),
            createButton("Watch", "Watch selected element for DOM mutations", () => { watchElement(); }),
            createButton("Stop watch", "Disconnect mutation observers", stopWatch),
            createButton("Copy DOM", "Copy sanitized DOM report", function () { void copyInspection(this); }),
            createButton("Exit", "Close inspector", stopInspection));
        const status = document.createElement("div");
        status.className = `${id}-status`;
        const details = document.createElement("pre");
        details.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere;margin:5px 0;font:inherit";
        inspector.append(actions, status, details);
        root.append(toolbar, logArea, inspector);
        document.body.appendChild(root);
        Object.assign(state, { root, logArea, inspector, inspectorText: details, statusBar: status });
        attachUIObserver();
        return true;
    }
    function attachUIObserver() {
        if (typeof MutationObserver === "undefined" || !document.body) return;
        if (state.uiObserver) state.uiObserver.disconnect();
        // Only direct children of body, not the constantly changing React subtree.
        state.uiObserver = new MutationObserver(() => {
            if (state.root && (!state.root.isConnected || state.observedBody !== document.body)) {
                stopPicker();
                stopWatch();
                removeHighlight();
                setViewportListeners(false);
                if (state.root) state.root.remove();
                if (state.resizeObserver) state.resizeObserver.disconnect();
                state.resizeObserver = null;
                state.selected = null;
                state.root = state.logArea = state.inspector = state.inspectorText = state.statusBar = null;
                state.uiObserver.disconnect();
            }
        });
        state.uiObserver.observe(document.body, { childList: true });
        if (document.documentElement) state.uiObserver.observe(document.documentElement, { childList: true });
        state.observedBody = document.body;
    }
    function showPanel(panel) {
        if (!ensureUI()) return false;
        state.root.hidden = false;
        state.panelMode = panel;
        setViewportListeners(panel === "inspect");
        state.logArea.hidden = panel !== "logs";
        state.inspector.hidden = panel !== "inspect";
        if (panel === "logs") renderLogs();
        else updateInspector();
        return true;
    }
    function toggleView() {
        if (!ensureUI()) return false;
        if (!state.root.hidden) {
            // A hidden debugger must not keep an active DOM picker or watch.
            stopInspection();
            state.root.hidden = true;
            return false;
        }
        showPanel("logs");
        return true;
    }

    function destroy() {
        if (state.destroyed) return;
        state.destroyed = true;
        stopInspection();
        if (state.uiObserver) state.uiObserver.disconnect();
        if (state.resizeObserver) state.resizeObserver.disconnect();
        for (const handle of state.frames) {
            if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle);
        }
        state.frames.clear();
        for (const [button, saved] of state.statuses) {
            clearTimeout(saved.timer);
            button.replaceChildren(...saved.nodes);
        }
        state.statuses.clear();
        if (state.root) state.root.remove();
        if (state.style) state.style.remove();
        removeHighlight();
        state.root = state.logArea = state.inspector = state.inspectorText = state.statusBar = state.style = null;
        clear();
    }

    return Object.freeze({
        log, info, warn, error, copy, clear, toggleView,
        inspect, inspectElement, watchElement, stopInspection,
        getInspectionReport, copyInspection, destroy
    });
}

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
    else start();
})( (() => {
    const supplied = typeof GM_info !== "undefined" && GM_info && typeof GM_info === "object" ? GM_info :
        (typeof GM !== "undefined" && GM && GM.info && typeof GM.info === "object" ? GM.info : {});
    const script = supplied.script && typeof supplied.script === "object" ? supplied.script : {};
    return {
        ...supplied,
        script: {
            ...script,
            name: typeof script.name === "string" && script.name.trim() ? script.name : "Torn Job Points Default Setter",
            version: typeof script.version === "string" ? script.version : "1.2.3"
        }
    };
})());
