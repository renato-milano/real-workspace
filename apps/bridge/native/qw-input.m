// qw-input: helper nativo del bridge per l'input remoto sulle finestre macOS.
// Scritto in Objective-C perché i Command Line Tools attuali non compilano Swift (modulemap duplicato).
//
// Protocollo: una richiesta JSON per riga su stdin, una risposta JSON per riga su stdout (solo dove serve).
//   {"op":"trusted"}                 → {"op":"trusted","trusted":bool}
//   {"op":"bounds","windowId":N}     → {"op":"bounds","windowId":N,"x","y","w","h","pid"} | {..., "missing":true}
//   {"op":"focus","windowId":N}      porta app e finestra in primo piano
//   {"op":"move","x","y"}            sposta il cursore (trascina se il tasto è premuto)
//   {"op":"down","x","y"} / {"op":"up","x","y"}
//   {"op":"scroll","dx","dy"}        scroll in pixel
//   {"op":"type","text"}             scrive testo Unicode (accenti inclusi) nella finestra in primo piano
//   {"op":"key","key","count"}       tasto speciale: "return" | "backspace" | "escape", ripetuto count volte
//   {"op":"sleep","ms"}              pausa (max 1 s) tra due comandi, es. tra testo e invio
// Coordinate: punti globali con origine in alto a sinistra (le stesse di CGWindowList e CGEvent).
//
// Build: clang -fobjc-arc -O2 qw-input.m -framework AppKit -framework ApplicationServices -o bin/qw-input

#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>

static BOOL buttonDown = NO;
static NSDate *lastDown = nil;
static int64_t clickCount = 1;
static CGPoint lastDownPoint = {0, 0};

static void reply(NSDictionary *obj) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:obj options:0 error:nil];
  if (!data) return;
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

static NSDictionary *windowInfo(CGWindowID windowId) {
  CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow, windowId);
  NSArray *arr = CFBridgingRelease(list);
  return arr.count ? arr[0] : nil;
}

static BOOL windowBounds(NSDictionary *info, CGRect *out) {
  NSDictionary *dict = info[(__bridge NSString *)kCGWindowBounds];
  return dict && CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)dict, out);
}

static void focusWindow(CGWindowID windowId) {
  NSDictionary *info = windowInfo(windowId);
  CGRect target;
  if (!info || !windowBounds(info, &target)) return;
  pid_t pid = [info[(__bridge NSString *)kCGWindowOwnerPID] intValue];
  // Da macOS 14 NSRunningApplication.activate da un processo in background può essere ignorato;
  // con il permesso Accessibilità impostare kAXFrontmost sull'app è affidabile.
  AXUIElementRef app = AXUIElementCreateApplication(pid);
  AXUIElementSetAttributeValue(app, kAXFrontmostAttribute, kCFBooleanTrue);

  // Tra le finestre AX dell'app alziamo quella con posizione e dimensioni uguali alla finestra catturata.
  CFArrayRef windows = NULL;
  if (AXUIElementCopyAttributeValue(app, kAXWindowsAttribute, (CFTypeRef *)&windows) == kAXErrorSuccess && windows) {
    for (CFIndex i = 0; i < CFArrayGetCount(windows); i++) {
      AXUIElementRef w = CFArrayGetValueAtIndex(windows, i);
      CFTypeRef posRef = NULL, sizeRef = NULL;
      CGPoint pos = CGPointZero;
      CGSize size = CGSizeZero;
      if (AXUIElementCopyAttributeValue(w, kAXPositionAttribute, &posRef) == kAXErrorSuccess) {
        AXValueGetValue(posRef, kAXValueTypeCGPoint, &pos);
        CFRelease(posRef);
      }
      if (AXUIElementCopyAttributeValue(w, kAXSizeAttribute, &sizeRef) == kAXErrorSuccess) {
        AXValueGetValue(sizeRef, kAXValueTypeCGSize, &size);
        CFRelease(sizeRef);
      }
      if (fabs(pos.x - target.origin.x) < 2 && fabs(pos.y - target.origin.y) < 2 &&
          fabs(size.width - target.size.width) < 2 && fabs(size.height - target.size.height) < 2) {
        AXUIElementPerformAction(w, kAXRaiseAction);
        AXUIElementSetAttributeValue(w, kAXMainAttribute, kCFBooleanTrue);
        break;
      }
    }
    CFRelease(windows);
  }
  CFRelease(app);
}

static void postMouse(CGEventType type, CGPoint p, int64_t clicks) {
  CGEventRef e = CGEventCreateMouseEvent(NULL, type, p, kCGMouseButtonLeft);
  if (!e) return;
  CGEventSetIntegerValueField(e, kCGMouseEventClickState, clicks);
  CGEventPost(kCGHIDEventTap, e);
  CFRelease(e);
}

// Testo come eventi tastiera Unicode: indipendente dal layout di tastiera, funziona anche nei terminali.
// Pezzi da 20 unità UTF-16 (limite pratico di CGEventKeyboardSetUnicodeString), senza spezzare le coppie surrogate.
static void typeUnicode(NSString *text) {
  NSUInteger i = 0;
  while (i < text.length) {
    NSUInteger len = MIN(20, text.length - i);
    if (len < text.length - i && CFStringIsSurrogateHighCharacter([text characterAtIndex:i + len - 1])) len--;
    unichar buf[20];
    [text getCharacters:buf range:NSMakeRange(i, len)];
    for (int down = 1; down >= 0; down--) {
      CGEventRef e = CGEventCreateKeyboardEvent(NULL, 0, down);
      if (!e) return;
      CGEventKeyboardSetUnicodeString(e, len, buf);
      CGEventPost(kCGHIDEventTap, e);
      CFRelease(e);
    }
    i += len;
    usleep(8000); // con 2 ms TextEdit perdeva caratteri: gli eventi arrivavano più in fretta di quanto li elabora
  }
}

static void pressKey(CGKeyCode code, int count) {
  for (int i = 0; i < count; i++) {
    for (int down = 1; down >= 0; down--) {
      CGEventRef e = CGEventCreateKeyboardEvent(NULL, code, down);
      if (!e) return;
      CGEventPost(kCGHIDEventTap, e);
      CFRelease(e);
    }
    usleep(1000);
  }
}

static CGPoint pointOf(NSDictionary *msg) {
  return CGPointMake([msg[@"x"] doubleValue], [msg[@"y"] doubleValue]);
}

int main(void) {
  @autoreleasepool {
    lastDown = [NSDate distantPast];
    char buf[4096];
    while (fgets(buf, sizeof buf, stdin)) {
      @autoreleasepool {
        NSData *data = [NSData dataWithBytes:buf length:strlen(buf)];
        NSDictionary *msg = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
        if (![msg isKindOfClass:[NSDictionary class]]) continue;
        NSString *op = msg[@"op"];

        if ([op isEqualToString:@"trusted"]) {
          // Con prompt=YES macOS mostra la richiesta del permesso Accessibilità la prima volta.
          NSDictionary *opts = @{(__bridge NSString *)kAXTrustedCheckOptionPrompt : @YES};
          reply(@{@"op" : @"trusted", @"trusted" : @(AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)opts))});

        } else if ([op isEqualToString:@"bounds"]) {
          CGWindowID wid = (CGWindowID)[msg[@"windowId"] unsignedIntValue];
          NSDictionary *info = windowInfo(wid);
          CGRect r;
          if (info && windowBounds(info, &r)) {
            reply(@{@"op" : @"bounds", @"windowId" : @(wid), @"x" : @(r.origin.x), @"y" : @(r.origin.y),
                    @"w" : @(r.size.width), @"h" : @(r.size.height),
                    @"pid" : info[(__bridge NSString *)kCGWindowOwnerPID] ?: @0});
          } else {
            reply(@{@"op" : @"bounds", @"windowId" : @(wid), @"missing" : @YES});
          }

        } else if ([op isEqualToString:@"focus"]) {
          focusWindow((CGWindowID)[msg[@"windowId"] unsignedIntValue]);

        } else if ([op isEqualToString:@"move"]) {
          postMouse(buttonDown ? kCGEventLeftMouseDragged : kCGEventMouseMoved, pointOf(msg), clickCount);

        } else if ([op isEqualToString:@"down"]) {
          CGPoint p = pointOf(msg);
          // Doppio click: secondo down entro 400 ms e vicino al primo.
          NSDate *now = [NSDate date];
          BOOL repeat = [now timeIntervalSinceDate:lastDown] < 0.4 &&
                        hypot(p.x - lastDownPoint.x, p.y - lastDownPoint.y) < 6;
          clickCount = repeat ? clickCount + 1 : 1;
          lastDown = now;
          lastDownPoint = p;
          buttonDown = YES;
          postMouse(kCGEventLeftMouseDown, p, clickCount);

        } else if ([op isEqualToString:@"up"]) {
          buttonDown = NO;
          postMouse(kCGEventLeftMouseUp, pointOf(msg), clickCount);

        } else if ([op isEqualToString:@"type"]) {
          if ([msg[@"text"] isKindOfClass:[NSString class]]) typeUnicode(msg[@"text"]);

        } else if ([op isEqualToString:@"key"]) {
          NSDictionary *codes = @{@"return" : @36, @"backspace" : @51, @"escape" : @53};
          NSNumber *code = codes[msg[@"key"]];
          int count = MAX(1, MIN(2000, [msg[@"count"] intValue]));
          if (code) pressKey((CGKeyCode)code.intValue, count);

        } else if ([op isEqualToString:@"sleep"]) {
          usleep((useconds_t)MAX(0, MIN(1000, [msg[@"ms"] intValue])) * 1000);

        } else if ([op isEqualToString:@"scroll"]) {
          CGEventRef e = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitPixel, 2,
                                                       (int32_t)[msg[@"dy"] doubleValue],
                                                       (int32_t)[msg[@"dx"] doubleValue]);
          if (e) {
            CGEventPost(kCGHIDEventTap, e);
            CFRelease(e);
          }
        }
      }
    }
  }
  return 0;
}
