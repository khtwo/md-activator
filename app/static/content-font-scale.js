const CONTENT_FONT_SCALE_MIN = 0.5;
const CONTENT_FONT_SCALE_MAX = 3;
const CONTENT_FONT_SCALE_STEP = 0.1;

// Clamp a requested rendered-content font scale into the supported range and round it to a stable
// two-decimal step, so repeated +/- presses do not accumulate floating-point drift. Non-numeric or
// missing values fall back to 1 (the unscaled default).
const clampContentFontScale = (scale) => {
  const numeric = Number(scale);
  if (!Number.isFinite(numeric)) return 1;
  const bounded = Math.min(Math.max(numeric, CONTENT_FONT_SCALE_MIN), CONTENT_FONT_SCALE_MAX);
  return Math.round(bounded * 100) / 100;
};

const stepContentFontScale = (scale, direction) =>
  clampContentFontScale(clampContentFontScale(scale) + direction * CONTENT_FONT_SCALE_STEP);

const readStoredContentFontScale = () => {
  try {
    const stored = localStorage.getItem('mdViewerFontScale');
    return stored === null ? 1 : clampContentFontScale(stored);
  } catch {
    return 1;
  }
};

// Reactive rendered-content font-size control for the toolbar smaller/bigger buttons. The scale
// multiplies the rendered markdown body's font size (base text and headings) through the
// `--content-font-scale` CSS variable, is clamped to a sane range, and persists across sessions in
// localStorage. `ref`/`computed` are injected so this stays decoupled from the Vue import in app.js.
const createContentFontScale = ({ ref, computed }) => {
  const selectedFontScale = ref(readStoredContentFontScale());
  const contentFontStyle = computed(() => ({ '--content-font-scale': String(selectedFontScale.value) }));

  const applyContentFontScale = (scale) => {
    selectedFontScale.value = clampContentFontScale(scale);
    try {
      localStorage.setItem('mdViewerFontScale', String(selectedFontScale.value));
    } catch {
      // Ignore storage failures; the in-session font scale still applies.
    }
  };

  return {
    selectedFontScale,
    contentFontStyle,
    increaseContentFontSize: () => applyContentFontScale(stepContentFontScale(selectedFontScale.value, 1)),
    decreaseContentFontSize: () => applyContentFontScale(stepContentFontScale(selectedFontScale.value, -1))
  };
};
