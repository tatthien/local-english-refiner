(() => {
  if (window.__localEnglishRefinerLoaded) return;
  window.__localEnglishRefinerLoaded = true;

  const TEXT_INPUT_TYPES = new Set(["text", "search", "email", "url", "tel"]);
  const MAX_TEXT_LENGTH = 20_000;
  const ICON_SIZE = 30;
  const EDGE_GAP = 6;
  const PANEL_GAP = 12;

  type ControlSnapshot = {
    element: HTMLInputElement | HTMLTextAreaElement;
    kind: "control";
    fullText: string;
    start: number;
    end: number;
    text: string;
  };
  type RangeSnapshot = {
    kind: "range";
    range: Range;
    text: string;
    editable: HTMLElement;
  };
  type SourceSnapshot = ControlSnapshot | RangeSnapshot;
  type SelectionCandidate = { snapshot: SourceSnapshot; rect: DOMRect };

  let activeSelection: SelectionCandidate | null = null;
  let activeRequest = 0;
  let sourceSnapshot: SourceSnapshot | null = null;
  let activeStreamCancel: (() => void) | null = null;
  let streamingResultElement: HTMLParagraphElement | null = null;
  let panelFrame = 0;

  const host = document.createElement("div");
  host.id = "local-english-refiner-root";
  host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;";
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    *, *::before, *::after { box-sizing: border-box; }
    button { font: inherit; }
    .refiner-button {
      position: fixed;
      display: none;
      align-items: center;
      justify-content: center;
      width: ${ICON_SIZE}px;
      height: ${ICON_SIZE}px;
      padding: 0;
      border: 1px solid rgba(5, 150, 105, 0.35);
      border-radius: 999px;
      background: #059669;
      color: white;
      box-shadow: 0 4px 16px rgba(15, 23, 42, 0.2);
      cursor: pointer;
      pointer-events: auto;
      transition: transform 120ms ease, background 120ms ease, opacity 120ms ease;
    }
    .refiner-button:hover { background: #047857; transform: scale(1.06); }
    .refiner-button:focus-visible { outline: 3px solid rgba(16, 185, 129, 0.35); outline-offset: 2px; }
    .refiner-button.loading { cursor: wait; opacity: 0.82; }
    .refiner-button.loading svg { animation: refiner-spin 900ms linear infinite; }
    .refiner-button svg { width: 17px; height: 17px; }
    @keyframes refiner-spin { to { transform: rotate(360deg); } }

    .panel {
      position: fixed;
      display: none;
      width: min(390px, calc(100vw - 24px));
      max-height: min(440px, calc(100vh - 24px));
      overflow: hidden;
      border: 1px solid #e2e8f0;
      border-radius: 16px;
      background: #ffffff;
      color: #0f172a;
      box-shadow: 0 18px 50px rgba(15, 23, 42, 0.22);
      font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      pointer-events: auto;
    }
    .panel.visible { display: block; }
    .panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 13px 14px 10px;
      border-bottom: 1px solid #f1f5f9;
    }
    .panel-title { display: flex; align-items: center; gap: 8px; font-weight: 650; }
    .panel-mark {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      border-radius: 999px;
      background: #059669;
      color: white;
      font-size: 12px;
      font-weight: 750;
    }
    .close-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border: 0;
      border-radius: 8px;
      background: transparent;
      color: #64748b;
      cursor: pointer;
    }
    .close-button:hover { background: #f1f5f9; color: #0f172a; }
    .panel-body { padding: 12px 14px; overflow: auto; max-height: 326px; }
    .result {
      margin: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .status { display: flex; align-items: center; gap: 9px; color: #475569; }
    .status-dot {
      width: 14px;
      height: 14px;
      flex: 0 0 auto;
      border: 2px solid #cbd5e1;
      border-top-color: #059669;
      border-radius: 999px;
      animation: refiner-spin 750ms linear infinite;
    }
    .error { margin: 0; color: #b91c1c; white-space: pre-wrap; }
    .metrics { margin-top: 10px; color: #94a3b8; font-size: 12px; }
    .panel-actions {
      display: none;
      justify-content: flex-end;
      gap: 8px;
      padding: 10px 14px 13px;
      border-top: 1px solid #f1f5f9;
    }
    .panel-actions.visible { display: flex; }
    .action-button {
      min-height: 34px;
      padding: 6px 12px;
      border: 1px solid #cbd5e1;
      border-radius: 9px;
      background: white;
      color: #334155;
      font-weight: 600;
      cursor: pointer;
    }
    .action-button:hover { background: #f8fafc; }
    .action-button.primary { border-color: #059669; background: #059669; color: white; }
    .action-button.primary:hover { background: #047857; }
    @media (prefers-color-scheme: dark) {
      .panel { border-color: #334155; background: #0f172a; color: #f8fafc; box-shadow: 0 18px 50px rgba(0, 0, 0, 0.45); }
      .panel-header, .panel-actions { border-color: #1e293b; }
      .close-button { color: #94a3b8; }
      .close-button:hover, .action-button:hover { background: #1e293b; color: #f8fafc; }
      .status { color: #cbd5e1; }
      .action-button { border-color: #475569; background: #0f172a; color: #e2e8f0; }
      .action-button.primary { border-color: #10b981; background: #059669; color: white; }
    }
  `;

  const button = document.createElement("button");
  button.className = "refiner-button";
  button.type = "button";
  button.title = "Refine English";
  button.setAttribute("aria-label", "Refine English");
  button.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 2.75 13.6 8.4 19.25 10l-5.65 1.6L12 17.25l-1.6-5.65L4.75 10l5.65-1.6L12 2.75Z" fill="currentColor"/>
      <path d="m18.5 15 .65 2.35L21.5 18l-2.35.65L18.5 21l-.65-2.35L15.5 18l2.35-.65L18.5 15Z" fill="currentColor" opacity=".8"/>
    </svg>`;

  const panel = document.createElement("section");
  panel.className = "panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "English refinement result");
  panel.innerHTML = `
    <header class="panel-header">
      <div class="panel-title"><span class="panel-mark">✦</span><span>Local English Refiner</span></div>
      <button class="close-button" type="button" aria-label="Close">✕</button>
    </header>
    <div class="panel-body"><div class="status"><span class="status-dot"></span><span>Refining locally…</span></div></div>
    <footer class="panel-actions">
      <button class="action-button copy-button" type="button">Copy</button>
      <button class="action-button primary apply-button" type="button">Apply</button>
    </footer>`;

  shadow.append(style, button, panel);
  document.documentElement.append(host);

  const panelBody = panel.querySelector<HTMLDivElement>(".panel-body")!;
  const panelActions = panel.querySelector<HTMLElement>(".panel-actions")!;
  const closeButton = panel.querySelector<HTMLButtonElement>(".close-button")!;
  const copyButton = panel.querySelector<HTMLButtonElement>(".copy-button")!;
  const applyButton = panel.querySelector<HTMLButtonElement>(".apply-button")!;

  // Keep the page selection intact while interacting with our overlay.
  shadow.addEventListener("mousedown", (event) => event.preventDefault());

  function activeTextControl(): HTMLInputElement | HTMLTextAreaElement | null {
    const element = document.activeElement;
    if (element instanceof HTMLTextAreaElement) {
      return element.disabled || element.readOnly ? null : element;
    }
    if (element instanceof HTMLInputElement) {
      return !element.disabled && !element.readOnly && TEXT_INPUT_TYPES.has(element.type)
        ? element
        : null;
    }
    return null;
  }

  function closestEditable(node: Node | null): HTMLElement | null {
    const element = node instanceof Element ? node : node?.parentElement;
    const editable = element?.closest<HTMLElement>(
      "[contenteditable='true'], [contenteditable='plaintext-only']",
    );
    return editable?.isContentEditable ? editable : null;
  }

  function copySelectionStyles(
    source: HTMLInputElement | HTMLTextAreaElement,
    target: HTMLDivElement,
  ): void {
    const computed = getComputedStyle(source);
    const properties = [
      "borderBottomWidth",
      "borderLeftWidth",
      "borderRightWidth",
      "borderTopWidth",
      "boxSizing",
      "fontFamily",
      "fontSize",
      "fontStyle",
      "fontVariant",
      "fontWeight",
      "letterSpacing",
      "lineHeight",
      "paddingBottom",
      "paddingLeft",
      "paddingRight",
      "paddingTop",
      "textAlign",
      "textIndent",
      "textTransform",
      "wordSpacing",
    ] as const;

    for (const property of properties) target.style[property] = computed[property];
  }

  function controlOffsetRect(
    element: HTMLInputElement | HTMLTextAreaElement,
    offset: number,
  ): DOMRect {
    const elementRect = element.getBoundingClientRect();
    const mirror = document.createElement("div");
    const marker = document.createElement("span");
    copySelectionStyles(element, mirror);
    mirror.style.position = "fixed";
    mirror.style.left = `${elementRect.left}px`;
    mirror.style.top = `${elementRect.top}px`;
    mirror.style.width = `${elementRect.width}px`;
    mirror.style.height = `${elementRect.height}px`;
    mirror.style.overflow = "hidden";
    mirror.style.pointerEvents = "none";
    mirror.style.visibility = "hidden";
    mirror.style.whiteSpace =
      element instanceof HTMLTextAreaElement ? "pre-wrap" : "pre";
    mirror.style.overflowWrap = "break-word";

    mirror.textContent = element.value.slice(0, offset);
    marker.textContent = element.value.slice(offset, offset + 1) || "\u200b";
    mirror.append(marker);
    document.body.append(mirror);

    const markerRect = marker.getBoundingClientRect();
    mirror.remove();
    const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight) || markerRect.height;
    const left = Math.max(
      elementRect.left,
      Math.min(elementRect.right, markerRect.left - element.scrollLeft),
    );
    const top = Math.max(
      elementRect.top,
      Math.min(elementRect.bottom - lineHeight, markerRect.top - element.scrollTop),
    );
    return new DOMRect(left, top, 1, lineHeight);
  }

  function controlSelectionRect(
    element: HTMLInputElement | HTMLTextAreaElement,
    start: number,
    end: number,
  ): DOMRect {
    const elementRect = element.getBoundingClientRect();
    const startRect = controlOffsetRect(element, start);
    const endRect = controlOffsetRect(element, end);
    const isSingleLine = Math.abs(startRect.top - endRect.top) < 1;
    const left = isSingleLine
      ? Math.min(startRect.left, endRect.left)
      : elementRect.left;
    const right = isSingleLine
      ? Math.max(startRect.right, endRect.right)
      : elementRect.right;
    const top = Math.min(startRect.top, endRect.top);
    const bottom = Math.max(startRect.bottom, endRect.bottom);
    return new DOMRect(left, top, Math.max(1, right - left), Math.max(1, bottom - top));
  }

  function currentSelection(): SelectionCandidate | null {
    const control = activeTextControl();
    if (control) {
      const start = control.selectionStart ?? 0;
      const end = control.selectionEnd ?? 0;
      if (end <= start) return null;
      const text = control.value.slice(start, end);
      if (!text.trim()) return null;
      return {
        snapshot: {
          kind: "control",
          element: control,
          fullText: control.value,
          start,
          end,
          text,
        },
        rect: controlSelectionRect(control, start, end),
      };
    }

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
    const anchorEditable = closestEditable(selection.anchorNode);
    const focusEditable = closestEditable(selection.focusNode);
    if (!anchorEditable || anchorEditable !== focusEditable) return null;
    const range = selection.getRangeAt(0);
    const text = range.toString();
    if (!text.trim() || host.contains(range.commonAncestorContainer)) return null;
    const rects = range.getClientRects();
    const rect = rects.item(rects.length - 1) || range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;

    return {
      snapshot: {
        kind: "range",
        range: range.cloneRange(),
        text,
        editable: anchorEditable,
      },
      rect,
    };
  }

  function snapshotRect(snapshot: SourceSnapshot): DOMRect | null {
    if (snapshot.kind === "control") {
      return snapshot.element.isConnected
        ? controlSelectionRect(snapshot.element, snapshot.start, snapshot.end)
        : null;
    }
    if (!snapshot.range.startContainer.isConnected || !snapshot.range.endContainer.isConnected) {
      return null;
    }
    const rects = snapshot.range.getClientRects();
    return rects.item(rects.length - 1) || snapshot.range.getBoundingClientRect();
  }

  function hideButton() {
    button.style.display = "none";
  }

  function hidePanel() {
    panel.classList.remove("visible");
    panelActions.classList.remove("visible");
  }

  function closePanel() {
    if (activeStreamCancel) {
      const cancel = activeStreamCancel;
      activeStreamCancel = null;
      activeRequest += 1;
      cancel();
    }
    button.classList.remove("loading");
    hidePanel();
    sourceSnapshot = null;
    refreshSelection();
  }

  function positionOverlay() {
    if (!activeSelection) {
      hideButton();
      return;
    }

    const rect = activeSelection.rect;
    if (rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) {
      hideButton();
      return;
    }

    const preferredLeft = rect.right + EDGE_GAP;
    const preferredTop = rect.bottom + EDGE_GAP;
    const left = Math.max(
      EDGE_GAP,
      Math.min(
        innerWidth - ICON_SIZE - EDGE_GAP,
        preferredLeft + ICON_SIZE <= innerWidth ? preferredLeft : rect.left - ICON_SIZE - EDGE_GAP,
      ),
    );
    const top = Math.max(
      EDGE_GAP,
      Math.min(
        innerHeight - ICON_SIZE - EDGE_GAP,
        preferredTop + ICON_SIZE <= innerHeight ? preferredTop : rect.top - ICON_SIZE - EDGE_GAP,
      ),
    );

    button.style.left = `${left}px`;
    button.style.top = `${top}px`;
    if (panel.classList.contains("visible")) {
      hideButton();
      positionPanel();
    } else {
      button.style.display = "inline-flex";
    }
  }

  function refreshSelection(): void {
    if (panel.classList.contains("visible")) return;
    activeSelection = currentSelection();
    positionOverlay();
  }

  let selectionFrame = 0;
  function scheduleSelectionRefresh(): void {
    cancelAnimationFrame(selectionFrame);
    selectionFrame = requestAnimationFrame(refreshSelection);
  }

  function repositionSelectionOverlay(): void {
    if (panel.classList.contains("visible") && sourceSnapshot && activeSelection) {
      const rect = snapshotRect(sourceSnapshot);
      if (rect) activeSelection = { snapshot: sourceSnapshot, rect };
      positionOverlay();
      return;
    }
    refreshSelection();
  }

  function positionPanel() {
    if (!activeSelection) return;
    const panelRect = panel.getBoundingClientRect();
    const width = panelRect.width || Math.min(390, innerWidth - 24);
    const height = panelRect.height;
    const selectionRect = activeSelection.rect;
    const maxLeft = innerWidth - width - PANEL_GAP;
    const maxTop = innerHeight - height - PANEL_GAP;
    const clampLeft = (left: number) => Math.max(PANEL_GAP, Math.min(maxLeft, left));
    const clampTop = (top: number) => Math.max(PANEL_GAP, Math.min(maxTop, top));
    const alignedLeft = clampLeft(selectionRect.left);
    const alignedTop = clampTop(selectionRect.top);
    const candidates = [
      {
        left: alignedLeft,
        top: selectionRect.bottom + PANEL_GAP,
        fits: selectionRect.bottom + PANEL_GAP + height <= innerHeight - PANEL_GAP,
      },
      {
        left: alignedLeft,
        top: selectionRect.top - height - PANEL_GAP,
        fits: selectionRect.top - height - PANEL_GAP >= PANEL_GAP,
      },
      {
        left: selectionRect.right + PANEL_GAP,
        top: alignedTop,
        fits: selectionRect.right + PANEL_GAP + width <= innerWidth - PANEL_GAP,
      },
      {
        left: selectionRect.left - width - PANEL_GAP,
        top: alignedTop,
        fits: selectionRect.left - width - PANEL_GAP >= PANEL_GAP,
      },
    ];
    const position = candidates.find((candidate) => candidate.fits) ??
      (innerHeight - selectionRect.bottom >= selectionRect.top
        ? candidates[0]!
        : candidates[1]!);
    panel.style.left = `${clampLeft(position.left)}px`;
    panel.style.top = `${clampTop(position.top)}px`;
  }

  function schedulePanelPosition(): void {
    cancelAnimationFrame(panelFrame);
    panelFrame = requestAnimationFrame(positionPanel);
  }

  function dispatchEditEvents(element: HTMLElement, insertedText: string): void {
    try {
      element.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: insertedText,
        }),
      );
    } catch {
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setControlValue(
    element: HTMLInputElement | HTMLTextAreaElement,
    value: string,
  ): void {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
  }

  function applyRevision(snapshot: SourceSnapshot, revisedText: string): void {
    if (snapshot.kind === "control") {
      const { element } = snapshot;
      if (!element.isConnected) {
        throw new Error("The original editor is no longer available.");
      }
      const current = element.value;
      if (current !== snapshot.fullText) {
        throw new Error("The text changed while it was being refined. Please try again.");
      }
      element.focus();
      const updated = `${current.slice(0, snapshot.start)}${revisedText}${current.slice(snapshot.end)}`;
      setControlValue(element, updated);
      const caret = snapshot.start + revisedText.length;
      element.setSelectionRange(caret, caret);
      dispatchEditEvents(element, revisedText);
      return;
    }

    const { range } = snapshot;
    if (!range.startContainer.isConnected || !range.endContainer.isConnected) {
      throw new Error("The original selection is no longer available.");
    }
    if (range.toString() !== snapshot.text) {
      throw new Error("The text changed while it was being refined. Please try again.");
    }

    range.deleteContents();
    const textNode = document.createTextNode(revisedText);
    range.insertNode(textNode);
    range.setStartAfter(textNode);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    dispatchEditEvents(snapshot.editable, revisedText);
  }

  function showLoading() {
    button.classList.add("loading");
    streamingResultElement = null;
    panelBody.innerHTML = `<div class="status"><span class="status-dot"></span><span>Refining locally…</span></div>`;
    panelActions.classList.remove("visible");
    panel.classList.add("visible");
    hideButton();
    positionPanel();
  }

  function showStreaming(text: string): void {
    if (!streamingResultElement) {
      panelBody.innerHTML = "";
      streamingResultElement = document.createElement("p");
      streamingResultElement.className = "result";
      streamingResultElement.setAttribute("aria-live", "polite");
      panelBody.append(streamingResultElement);
      panelActions.classList.remove("visible");
      panel.classList.add("visible");
      hideButton();
    }
    streamingResultElement.textContent = text;
    panelBody.scrollTop = panelBody.scrollHeight;
    schedulePanelPosition();
  }

  function showError(message: string): void {
    streamingResultElement = null;
    panelBody.innerHTML = "";
    const error = document.createElement("p");
    error.className = "error";
    error.textContent = message;
    panelBody.append(error);
    panelActions.classList.remove("visible");
    panel.classList.add("visible");
    hideButton();
    button.classList.remove("loading");
    schedulePanelPosition();
  }

  function showResult(result: RefinementResult): void {
    streamingResultElement = null;
    panelBody.innerHTML = "";
    const text = document.createElement("p");
    text.className = "result";
    text.textContent = result.refined;
    panelBody.append(text);

    const tokensPerSecond = result.metrics?.outputTokensPerSecond;
    const totalDurationMs = result.metrics?.totalDurationMs;
    if (tokensPerSecond || totalDurationMs) {
      const metrics = document.createElement("div");
      metrics.className = "metrics";
      const parts = [];
      if (tokensPerSecond) parts.push(`${tokensPerSecond} tokens/s`);
      if (totalDurationMs) parts.push(`${(totalDurationMs / 1000).toFixed(1)} s`);
      metrics.textContent = parts.join(" · ");
      panelBody.append(metrics);
    }

    panel.dataset.refined = result.refined;
    panelActions.classList.add("visible");
    panel.classList.add("visible");
    hideButton();
    button.classList.remove("loading");
    schedulePanelPosition();
  }

  function requestRefinement(
    text: string,
    onDelta: (accumulatedText: string) => void,
  ): Promise<RefinementResult> {
    return new Promise<RefinementResult>((resolve, reject) => {
      const port = chrome.runtime.connect({ name: "refine-english-stream" });
      let accumulated = "";
      let settled = false;

      const cleanup = () => {
        if (activeStreamCancel === cancel) activeStreamCancel = null;
      };
      const cancel = () => {
        if (settled) return;
        settled = true;
        port.disconnect();
        cleanup();
      };
      activeStreamCancel = cancel;

      port.onMessage.addListener((event: unknown) => {
        if (settled) return;
        if (typeof event !== "object" || event === null || !("type" in event)) return;
        if (event.type === "delta") {
          accumulated += "delta" in event && typeof event.delta === "string" ? event.delta : "";
          onDelta(accumulated);
          return;
        }
        if (event.type === "error") {
          settled = true;
          cleanup();
          port.disconnect();
          reject(
            new Error(
              "error" in event && typeof event.error === "string"
                ? event.error
                : "The refinement request failed.",
            ),
          );
          return;
        }
        if (event.type === "done") {
          settled = true;
          cleanup();
          port.disconnect();
          resolve(event as unknown as RefinementResult);
        }
      });

      port.onDisconnect.addListener(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(
          new Error(
            chrome.runtime.lastError?.message || "The refinement connection closed unexpectedly.",
          ),
        );
      });

      port.postMessage({ type: "start", text });
    });
  }

  button.addEventListener("click", async () => {
    if (!activeSelection || button.classList.contains("loading")) return;

    const snapshot = activeSelection.snapshot;
    const text = snapshot.text.trim();
    if (!text) {
      showError("Enter or select some text first.");
      return;
    }
    if (text.length > MAX_TEXT_LENGTH) {
      showError(`Please refine no more than ${MAX_TEXT_LENGTH.toLocaleString()} characters at once.`);
      return;
    }

    sourceSnapshot = snapshot;
    const requestId = ++activeRequest;
    showLoading();

    try {
      const result = await requestRefinement(snapshot.text, showStreaming);
      if (requestId === activeRequest) showResult(result);
    } catch (error: unknown) {
      if (requestId === activeRequest) {
        const message = error instanceof Error ? error.message : "The refinement request failed.";
        const suffix = /fetch|service|connect|Receiving end/i.test(message)
          ? " Make sure the backend is running on 127.0.0.1:3030."
          : "";
        showError(`${message}${suffix}`);
      }
    }
  });

  closeButton.addEventListener("click", closePanel);

  copyButton.addEventListener("click", async () => {
    const revised = panel.dataset.refined || "";
    try {
      await navigator.clipboard.writeText(revised);
      copyButton.textContent = "Copied";
      setTimeout(() => (copyButton.textContent = "Copy"), 1200);
    } catch {
      showError("Chrome could not copy the revision to the clipboard.");
    }
  });

  applyButton.addEventListener("click", () => {
    try {
      if (!sourceSnapshot) throw new Error("The original text is no longer available.");
      applyRevision(sourceSnapshot, panel.dataset.refined || "");
      closePanel();
    } catch (error: unknown) {
      showError(error instanceof Error ? error.message : "The revision could not be applied.");
    }
  });

  document.addEventListener("mouseup", scheduleSelectionRefresh, true);
  document.addEventListener("keyup", scheduleSelectionRefresh, true);
  document.addEventListener("input", scheduleSelectionRefresh, true);
  document.addEventListener("scroll", repositionSelectionOverlay, true);
  window.addEventListener("resize", repositionSelectionOverlay);
})();
