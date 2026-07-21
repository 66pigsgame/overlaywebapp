// 1080px-wide reference canvas from social/first-post/geometry.json:
// pad 34px * scale 2 = 68px. Font size: brand.css applies both `.mono`
// (font-size: 11px) and `.chrome` (font-size: 10px) to the same corner
// elements (template.html: class="chrome chrome-tl mono") -- `.chrome`
// is declared after `.mono` in the stylesheet, so at equal specificity
// its 10px wins the cascade. Effective size is 10px * scale 2 = 20px.
export const PAD_RATIO = 68 / 1080;
export const FONT_SIZE_RATIO = 20 / 1080;
export const LETTER_SPACING_EM = 0.14;
export const BOX_HEIGHT_RATIO = 1.8; // multiplier on fontSize
