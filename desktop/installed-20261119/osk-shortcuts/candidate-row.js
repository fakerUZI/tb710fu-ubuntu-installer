import Pango from 'gi://Pango';

const WORD_SLOTS = 5;
const PAGE_WIDTH = 44;
const ROW_STYLE = 'spacing: 6px; padding: 6px 12px;';
const BUTTON_STYLE = 'min-width: 24px; padding: 6px 8px; margin: 0 2px; transition-duration: 0ms;';

// Keep the same actors and allocations while composition changes. Invisible
// page/empty slots reserve their space and cannot receive input.
export class CandidateRow {
    constructor(manager, suggestions) {
        this._manager = manager;
        this._row = suggestions;
        this._buttons = [];
        this._width = 0;
        this.active = false;
    }
    ownsSuggestions() {
        const children = this._row.get_children();
        return this._buttons.length === WORD_SLOTS + 2 &&
            children.length === this._buttons.length &&
            children.every((button, i) => button === this._buttons[i]);
    }
    _ensureButtons() {
        if (this.ownsSuggestions())
            return;
        this._manager.resetSuggestions();
        this._buttons = [];
        this._row.set_style(ROW_STYLE);
        for (let slot = 0; slot < WORD_SLOTS + 2; slot++) {
            this._manager.addSuggestion('', () => {
                const state = this._state;
                if (!this.active || !state)
                    return;
                if (slot === 0 && state.hasPrev)
                    state.onPage(-1);
                else if (slot === WORD_SLOTS + 1 && state.hasNext)
                    state.onPage(1);
                else if (slot > 0 && slot <= state.texts.length)
                    state.onSelect(slot - 1);
            });
            const button = this._row.get_children().at(-1);
            button.set_style(BUTTON_STYLE);
            button.can_focus = false;
            const label = button.get_child();
            if (label?.clutter_text) {
                label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                label.clutter_text.single_line_mode = true;
            }
            this._buttons.push(button);
        }
        this._sizedWidth = null;
    }
    update(texts, hasPrev, hasNext, onSelect, onPage) {
        this.active = texts.length > 0;
        this._state = {texts: texts.slice(0, WORD_SLOTS), hasPrev, hasNext, onSelect, onPage};
        if (!this.active && !this.ownsSuggestions()) {
            if (this._row.get_children().length)
                this._manager.resetSuggestions();
            this._buttons = [];
            return;
        }
        this._ensureButtons();
        this.setWidth(this._width);
        const labels = [hasPrev ? '‹' : '', ...Array.from({length: WORD_SLOTS},
            (_, index) => this._state.texts[index] ?? ''), hasNext ? '›' : ''];
        for (let slot = 0; slot < this._buttons.length; slot++) {
            const button = this._buttons[slot];
            const text = this.active ? labels[slot] : '';
            if (button.label !== text)
                button.label = text;
            button.visible = true;
            button.opacity = text ? 255 : 0;
            button.reactive = !!text;
        }
    }
    setWidth(width) {
        if (width > 0)
            this._width = width;
        if (!this.ownsSuggestions() || this._width < 100 || this._sizedWidth === this._width)
            return;
        // Seven permanent slots: five words and two paging controls.
        const overhead = 24 + 7 * 4 + 6 * 6 + PAGE_WIDTH * 2;
        const wordWidth = Math.max(40, Math.floor((this._width - overhead) / WORD_SLOTS));
        for (let i = 0; i < this._buttons.length; i++) {
            const button = this._buttons[i];
            button.remove_all_transitions();
            button.width = i === 0 || i === WORD_SLOTS + 1 ? PAGE_WIDTH : wordWidth;
        }
        this._sizedWidth = this._width;
    }
    visibleCount() {
        return this.active ? this._state.texts.length + Number(this._state.hasPrev) + Number(this._state.hasNext) : 0;
    }
    destroy() {
        this.active = false;
        this._state = null;
        if (this.ownsSuggestions())
            this._manager.resetSuggestions();
        this._buttons = [];
    }
}
