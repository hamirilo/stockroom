//! macOS のメニューバーで、修飾キーの無いキー（F・P・B・Space・0〜5・⇧D・⌥1 など）を
//! ほかのショートカットと同じく右端に「表示だけ」する（docs/MENUS.md §2）。
//!
//! これらのキーは検索欄などで文字を打つのにも使うので、メニューには取らせず、
//! 今までどおり一覧のキー処理（src/lib/commands.ts）が受ける。そのために
//! `-[NSMenu performKeyEquivalent:]` を差し替え、⌘・⌃・fn のどれも押されていない
//! キーではメニューを探さずに NO を返す。キーはそのまま入力欄や一覧へ届く。
//! ⌘ 付きのショートカット（⌘⇧J など）と fn＋F（フルスクリーン）はこれまでどおりメニューが受ける。

use std::sync::{Once, OnceLock};

use objc2::msg_send;
use objc2::runtime::{AnyClass, AnyObject, Bool, Imp, Sel};
use objc2::sel;

/// NSEventModifierFlagControl / Command / Function。
const CONTROL: usize = 1 << 18;
const COMMAND: usize = 1 << 20;
const FUNCTION: usize = 1 << 23;

type PerformKeyEquivalent = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> Bool;

/// 差し替える前の `performKeyEquivalent:`。
static ORIGINAL: OnceLock<PerformKeyEquivalent> = OnceLock::new();
static INSTALL: Once = Once::new();

unsafe extern "C-unwind" fn perform_key_equivalent(this: *mut AnyObject, cmd: Sel, event: *mut AnyObject) -> Bool {
    if !event.is_null() {
        // SAFETY: AppKit が渡す NSEvent。modifierFlags は NSUInteger を返す。
        let flags: usize = unsafe { msg_send![&*event, modifierFlags] };
        if flags & (COMMAND | CONTROL | FUNCTION) == 0 {
            return Bool::NO;
        }
    }
    match ORIGINAL.get() {
        // SAFETY: 差し替える前の NSMenu の実装を、同じ引数で呼ぶ。
        Some(original) => unsafe { original(this, cmd, event) },
        None => Bool::NO,
    }
}

/// 起動時に 1 回だけ呼ぶ（lib.rs の setup）。2 回目以降は何もしない。
pub fn install() {
    INSTALL.call_once(|| {
        let Some(class) = AnyClass::get(c"NSMenu") else {
            log::warn!("menu_keys: NSMenu が見つからない");
            return;
        };
        let Some(method) = class.instance_method(sel!(performKeyEquivalent:)) else {
            log::warn!("menu_keys: performKeyEquivalent: が見つからない");
            return;
        };
        // SAFETY: 同じ型（id self, SEL _cmd, NSEvent *event）→ BOOL の関数どうしの読み替え。
        // 差し替えはメインスレッドの setup の中で、キー入力を受ける前に行う。
        unsafe {
            let ours: Imp = std::mem::transmute::<PerformKeyEquivalent, Imp>(perform_key_equivalent);
            let original = method.set_implementation(ours);
            let _ = ORIGINAL.set(std::mem::transmute::<Imp, PerformKeyEquivalent>(original));
        }
    });
}
