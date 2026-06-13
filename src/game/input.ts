// WoW-style input: WASD + A/D keyboard turn, Q/E strafe, space jump,
// left-drag orbits the camera, right-drag mouselooks (turns the character),
// both buttons run forward, wheel zooms, Tab targets, 1-9/0/-/= cast,
// C/P/L/M/B windows, V nameplates, F interacts, R autorun.

export interface InputCallbacks {
  onTab(): void;
  onAbility(slot: number): void;
  onUiKey(key: 'interact' | 'bags' | 'char' | 'spellbook' | 'questlog' | 'map' | 'nameplates' | 'escape' | 'chat' | 'meters'): void;
  onClickPick(x: number, y: number, button: number): void;
}

const ABILITY_KEYS: Record<string, number> = {
  Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3, Digit5: 4, Digit6: 5,
  Digit7: 6, Digit8: 7, Digit9: 8, Digit0: 9, Minus: 10, Equal: 11,
};

export class Input {
  keys = new Set<string>();
  leftDown = false;
  rightDown = false;
  mouseX = 0;
  mouseY = 0;
  camYaw = Math.PI;
  camPitch = 0.32;
  camDist = 12;
  autorun = false;
  // toggle mouselook (backtick): mouse steers without holding a button,
  // like holding right-click permanently. Esc or backtick exits.
  mouselookToggle = false;
  private dragDistance = 0;
  private downButton = -1;

  // true whenever the character should turn with the mouse
  get mouselooking(): boolean {
    return this.rightDown || this.mouselookToggle;
  }

  constructor(private canvas: HTMLCanvasElement, private cb: InputCallbacks) {
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => { this.keys.delete(e.code); });
    window.addEventListener('blur', () => { this.keys.clear(); this.leftDown = false; this.rightDown = false; });
    canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
    window.addEventListener('mouseup', (e) => this.onMouseUp(e));
    window.addEventListener('mousemove', (e) => this.onMouseMove(e));
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.camDist = Math.min(22, Math.max(3, this.camDist + Math.sign(e.deltaY) * 1.4));
    }, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    // the browser force-exits pointer lock on Esc — keep the toggle in sync
    document.addEventListener('pointerlockchange', () => {
      if (this.mouselookToggle && document.pointerLockElement !== this.canvas) {
        this.mouselookToggle = false;
      }
    });
  }

  private setMouselookToggle(on: boolean): void {
    this.mouselookToggle = on;
    if (on) this.canvas.requestPointerLock?.();
    else if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.repeat) return;
    const tag = (document.activeElement?.tagName ?? '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    if (ABILITY_KEYS[e.code] !== undefined) {
      this.cb.onAbility(ABILITY_KEYS[e.code]);
      return;
    }
    switch (e.code) {
      case 'Tab':
        e.preventDefault();
        this.cb.onTab();
        return;
      case 'KeyF': this.cb.onUiKey('interact'); return;
      case 'KeyB': this.cb.onUiKey('bags'); return;
      case 'KeyC': this.cb.onUiKey('char'); return;
      case 'KeyP': this.cb.onUiKey('spellbook'); return;
      case 'KeyL': this.cb.onUiKey('questlog'); return;
      case 'KeyM': this.cb.onUiKey('map'); return;
      case 'KeyV': this.cb.onUiKey('nameplates'); return;
      case 'KeyN': this.cb.onUiKey('meters'); return;
      case 'Enter': case 'NumpadEnter': this.cb.onUiKey('chat'); return;
      case 'Escape': this.cb.onUiKey('escape'); return;
      case 'NumLock': case 'KeyR': this.autorun = !this.autorun; return;
      case 'Backquote': this.setMouselookToggle(!this.mouselookToggle); return;
    }
    this.keys.add(e.code);
    if (['KeyW', 'KeyS', 'ArrowUp', 'ArrowDown'].includes(e.code)) this.autorun = false;
  }

  private onMouseDown(e: MouseEvent): void {
    if (e.button === 0) this.leftDown = true;
    if (e.button === 2) this.rightDown = true;
    this.downButton = e.button;
    this.dragDistance = 0;
    // pointer lock is requested in onMouseMove once dragDistance > 5 —
    // a plain click (target/interact) never grabs the pointer
  }

  private onMouseUp(e: MouseEvent): void {
    const wasDrag = this.dragDistance > 5;
    if (e.button === 0) this.leftDown = false;
    if (e.button === 2) this.rightDown = false;
    if (!this.leftDown && !this.rightDown && !this.mouselookToggle && document.pointerLockElement) {
      document.exitPointerLock();
    }
    // no click-picking while toggled mouselook: the pointer is locked, so
    // clientX/Y is frozen and there is no cursor to pick with
    if (!wasDrag && !this.mouselookToggle && e.button === this.downButton && (e.target === this.canvas || document.pointerLockElement === this.canvas)) {
      this.cb.onClickPick(e.clientX, e.clientY, e.button);
    }
    this.downButton = -1;
  }

  private onMouseMove(e: MouseEvent): void {
    this.mouseX = e.clientX;
    this.mouseY = e.clientY;
    if (!this.leftDown && !this.rightDown && !this.mouselookToggle) return;
    const mx = e.movementX ?? 0, my = e.movementY ?? 0;
    if (this.leftDown || this.rightDown) {
      this.dragDistance += Math.abs(mx) + Math.abs(my);
      if (this.dragDistance > 5 && !document.pointerLockElement) {
        this.canvas.requestPointerLock?.();
      }
    }
    this.camYaw -= mx * 0.0045;
    this.camPitch = Math.min(1.35, Math.max(-0.4, this.camPitch + my * 0.0045));
  }

  readMoveInput(): {
    forward: boolean; back: boolean; turnLeft: boolean; turnRight: boolean;
    strafeLeft: boolean; strafeRight: boolean; jump: boolean;
  } {
    const k = this.keys;
    const bothButtons = this.leftDown && this.rightDown;
    const mouselook = this.rightDown;
    const forward = k.has('KeyW') || k.has('ArrowUp') || bothButtons || this.autorun;
    const back = k.has('KeyS') || k.has('ArrowDown');
    const aHeld = k.has('KeyA') || k.has('ArrowLeft');
    const dHeld = k.has('KeyD') || k.has('ArrowRight');
    const strafeLeft = k.has('KeyQ') || (mouselook && aHeld);
    const strafeRight = k.has('KeyE') || (mouselook && dHeld);
    const turnLeft = !mouselook && aHeld;
    const turnRight = !mouselook && dHeld;
    const jump = k.has('Space');
    return { forward, back, turnLeft, turnRight, strafeLeft, strafeRight, jump };
  }
}
