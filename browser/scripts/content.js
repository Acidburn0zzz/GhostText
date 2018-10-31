/* global oneEvent */

const knownElements = new Map();
const activeFields = new Set();

let isWaitingForActivation = false;

class ContentEditableWrapper {
	constructor(el) {
		this.el = el;
		this.classList = el.classList;
		this.addEventListener = el.addEventListener.bind(el);
		this.removeEventListener = el.removeEventListener.bind(el);
		this.blur = el.blur.bind(el);
	}
	get value() {
		return this.el.innerHTML;
	}
	set value(html) {
		this.el.innerHTML = html;
	}
}

class AdvancedTextWrapper {
	constructor(el, name, visualEl) {
		this.el = el;
		this.classList = visualEl.classList;
		document.addEventListener(`ghost-text:${name}:safesetup`, this.setClone.bind(this), {
			once: true
		});
		this.el.dispatchEvent(new CustomEvent(`ghost-text:${name}:unsafesetup`, {
			bubbles: true
		}));
	}
	setClone(event) {
		this.messenger = event.target;
	}
	addEventListener(type, callback) {
		this.messenger.addEventListener('input-from-browser', callback);
	}
	removeEventListener(type, callback) {
		this.messenger.removeEventListener('input-from-browser', callback);
	}
	get value() {
		return this.messenger.value;
	}
	set value(value) {
		if (this.messenger.value !== value) {
			this.messenger.value = value;
			this.messenger.dispatchEvent(new InputEvent('input-from-editor'));
		}
	}
}

function wrapField(field) {
	if (field.isContentEditable) {
		return new ContentEditableWrapper(field);
	}

	if (field.classList.contains('ace_text-input')) {
		const visualEl = field.parentNode.querySelector('.ace_scroller');
		return new AdvancedTextWrapper(field, 'ace', visualEl);
	}

	const cm = field.closest('.CodeMirror');
	if (cm) {
		const visualEl = cm.querySelector('.CodeMirror-sizer');
		return new AdvancedTextWrapper(cm, 'codemirror', visualEl);
	}

	return field;
}

class GhostTextField {
	constructor(field) {
		this.field = wrapField(field);
		this.send = this.send.bind(this);
		this.receive = this.receive.bind(this);
		this.deactivate = this.deactivate.bind(this);
		this.tryFocus = this.tryFocus.bind(this);
		field.addEventListener('focus', this.tryFocus);
		this.state = 'inactive';
	}

	async activate() {
		if (this.state === 'active') {
			return;
		}
		this.state = 'active';
		activeFields.add(this);

		this.field.classList.add('GT-field', 'GT-field--loading');

		const response = await fetch('http://localhost:4001');
		const {ProtocolVersion, WebSocketPort} = await response.json();
		if (ProtocolVersion !== 1) {
			throw new Error('Incompatible protocol version');
		}
		console.log('will open socket');
		this.socket = new WebSocket('ws://localhost:' + WebSocketPort);

		await oneEvent.promise(this.socket, 'open');
		console.log('socket open');

		this.socket.addEventListener('close', this.deactivate);
		this.socket.addEventListener('error', event => console.error('error!', event));
		this.socket.addEventListener('message', this.receive);
		this.field.addEventListener('input', this.send);
		this.field.classList.replace('GT-field--loading', 'GT-field--enabled');

		// Send first value to init tab
		this.send();
		updateCount();
	}

	send() {
		console.info('sending', this.field.value)
		this.socket.send(JSON.stringify({
			title: document.title, // TODO: move to first fetch
			url: location.host, // TODO: move to first fetch
			syntax: '', // TODO: move to first fetch
			text: this.field.value,
			selections: [
				{
					start: this.field.selectionStart || 0,
					end: this.field.selectionEnd || 0
				}
			]
		}));
	}

	receive(event) {
		const {
			text,
			selections
		} = JSON.parse(event.data);
		this.field.value = text;
		this.field.selectionStart = selections[0].start;
		this.field.selectionEnd = selections[0].end;
	}

	deactivate() {
		if (this.state === 'inactive') {
			return;
		}
		this.state = 'inactive';
		console.log('Disabling field');
		activeFields.delete(this);
		this.socket.close();
		this.field.removeEventListener('input', this.send);
		this.field.classList.remove('GT-field--enabled');
		updateCount();
	}

	tryFocus() {
		if (isWaitingForActivation && this.state === 'inactive') {
			this.activate();
			isWaitingForActivation = false;
		}
	}

	static deactivateAll() {
		for (const field of activeFields) {
			field.deactivate();
		}
	}
}

function updateCount() {
	chrome.runtime.sendMessage({
		code: 'connection-count',
		count: activeFields.size
	});
}

const selector = `
	textarea,
	[contenteditable=""],
	[contenteditable="true"]
`;
function registerElements() {
	for (const element of document.querySelectorAll(selector)) {
		// TODO: Only handle areas that are visible
		//  && element.getBoundingClientRect().width > 20
		if (!knownElements.has(element)) {
			knownElements.set(element, new GhostTextField(element));
		}
	}
}

function startGT() {
	registerElements();
	console.info(knownElements.size + ' elements on the page');
	if (knownElements.size === 0) {
		alert('No supported elements found!');
		return;
	}

	const focused = knownElements.get(document.activeElement);
	if (focused) {
		// Track the focused element automatically, unless GT is already active somewhere
		if (activeFields.size === 0) {
			focused.activate();
			return;
		}
		// Blur focused element to allow selection with a click/focus
		focused.field.blur();
	}

	// If there's one element and it's not active, activate.
	// If it's one and active, do nothing
	if (knownElements.size === 1) {
		if (activeFields.size === 0) {
			const [field] = knownElements.values();
			field.activate();
		}
	} else {
		isWaitingForActivation = true;
		if (activeFields.size === 0) {
			console.log('Click on the desired element to activate it.');
		} else {
			console.log('Click on the desired element to activate it or double-click the GhostText icon to stop the connection.');
		}
		// TODO: waiting timeout
	}
}

function stopGT() {
	GhostTextField.deactivateAll();
	isWaitingForActivation = false;
}

function init() {
	const script = document.createElement('script');
	script.src = chrome.runtime.getURL('scripts/unsafe-messenger.js');
	document.head.append(script);
}

init();

window.startGT = startGT;
window.stopGT = stopGT;
