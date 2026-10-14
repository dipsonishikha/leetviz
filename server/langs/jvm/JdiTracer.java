// Step tracer for JVM languages, built on the Java Debug Interface (JDI).
//
//   java -cp <dir> JdiTracer <out.json> <stdout.txt> <input.txt> <maxSteps> <userSource> <java home>
//        <classpath> <driver args...>
//
// Launches `LvMain trace ...` in a debuggee JVM, puts a breakpoint at the solution method, then
// single-steps (step into, line granularity) through every frame whose source file is the user's
// (Solution.java / Solution.kt / Solution.scala). Values are read straight from objects' fields
// (ArrayList.elementData, HashMap.table, ...) so the debuggee never has to run code for us.
// Writes the same trace JSON as engine/tracer.py.
import com.sun.jdi.*;
import com.sun.jdi.connect.*;
import com.sun.jdi.event.*;
import com.sun.jdi.request.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicLong;

public class JdiTracer {
  static final int MAX_ITEMS = 120, MAX_DEPTH = 3, FULL_FRAMES = 6;
  static final String[] EXCLUDE = { "java.*", "javax.*", "jdk.*", "sun.*", "com.sun.*", "kotlin.*", "scala.*", "LvMain*", "ListNode", "TreeNode", "javafx.*" };

  static final boolean DEBUG = System.getenv("LV_DEBUG") != null;
  static String userSource;
  static int maxSteps;
  static final StringBuilder steps = new StringBuilder();
  static int stepCount = 0;
  static final AtomicLong outBytes = new AtomicLong();
  static String error = null;
  static Integer errorLine = null;
  static boolean truncated = false;
  static int lastDepth = 0;

  public static void main(String[] a) throws Exception {
    String outFile = a[0], stdoutFile = a[1], inputFile = a[2];
    maxSteps = Integer.parseInt(a[3]);
    userSource = a[4];
    String javaHome = a[5], classpath = a[6];
    StringBuilder mainArgs = new StringBuilder("LvMain");
    for (int i = 7; i < a.length; i++) mainArgs.append(' ').append(quote(a[i]));

    LaunchingConnector lc = Bootstrap.virtualMachineManager().defaultConnector();
    Map<String, Connector.Argument> args = lc.defaultArguments();
    args.get("main").setValue(mainArgs.toString());
    args.get("options").setValue("-cp " + quote(classpath) + " -Xss512m -XX:+UseSerialGC -Xshare:auto");
    if (args.containsKey("home")) args.get("home").setValue(javaHome);
    VirtualMachine vm = lc.launch(args);

    Process p = vm.process();
    try (OutputStream stdin = p.getOutputStream()) { stdin.write(Files.readAllBytes(Paths.get(inputFile))); }
    OutputStream stdoutSink = new FileOutputStream(stdoutFile);
    Thread t1 = pump(p.getInputStream(), stdoutSink, true);
    Thread t2 = pump(p.getErrorStream(), OutputStream.nullOutputStream(), false);

    EventRequestManager erm = vm.eventRequestManager();
    ClassPrepareRequest cpr = erm.createClassPrepareRequest();
    cpr.addSourceNameFilter(userSource);
    cpr.enable();
    String method = a[8];

    boolean stepping = false;
    StepRequest stepReq = null;
    MethodExitRequest exitReq = null;
    EventQueue q = vm.eventQueue();
    vm.resume();
    outer:
    while (true) {
      EventSet es;
      try { es = q.remove(); } catch (VMDisconnectedException e) { break; }
      boolean resume = true;
      for (Event ev : es) {
        if (DEBUG) System.err.println("event " + ev);
        try {
          if (ev instanceof ClassPrepareEvent) {
            ReferenceType rt = ((ClassPrepareEvent) ev).referenceType();
            for (Method m : rt.methodsByName(method)) {
              if (m.isAbstract() || m.isNative() || m.location() == null || isForwarder(m)) continue;
              List<Location> locs = m.allLineLocations();
              if (locs.isEmpty()) continue;
              BreakpointRequest br = erm.createBreakpointRequest(m.location());
              br.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD);
              br.enable();
            }
          } else if (ev instanceof BreakpointEvent && !stepping) {
            BreakpointEvent be = (BreakpointEvent) ev;
            for (BreakpointRequest br : new ArrayList<>(erm.breakpointRequests())) erm.deleteEventRequest(br);
            ThreadReference th = be.thread();
            record(th, "call", null, null);
            stepping = true;
            stepReq = erm.createStepRequest(th, StepRequest.STEP_LINE, StepRequest.STEP_INTO);
            for (String x : EXCLUDE) stepReq.addClassExclusionFilter(x);
            stepReq.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD);
            stepReq.enable();
            exitReq = erm.createMethodExitRequest();
            exitReq.addThreadFilter(th);
            for (String x : EXCLUDE) exitReq.addClassExclusionFilter(x);
            exitReq.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD);
            exitReq.enable();
            ExceptionRequest exReq = erm.createExceptionRequest(null, true, true);
            exReq.addThreadFilter(th);
            exReq.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD);
            exReq.enable();
          } else if (ev instanceof StepEvent) {
            ThreadReference th = ((StepEvent) ev).thread();
            List<StackFrame> user = userFrames(th);
            if (user.isEmpty()) {
              // Back in the driver: the solution has returned.
              stopStepping(erm);
              stepping = false;
              continue;
            }
            int depth = user.size();
            record(th, depth > lastDepth ? "call" : "line", null, null);
          } else if (ev instanceof MethodExitEvent) {
            MethodExitEvent me = (MethodExitEvent) ev;
            Method m = me.method();
            if (!isUser(m) || m.isConstructor() || m.isStaticInitializer() || isForwarder(m)) continue;
            String ret = m.returnTypeName().equals("void") ? "{\"t\":\"prim\",\"v\":\"void\",\"k\":\"null\"}" : ser(me.returnValue(), 0);
            record(me.thread(), "return", ret, null);
          } else if (ev instanceof ExceptionEvent) {
            ExceptionEvent ee = (ExceptionEvent) ev;
            // Fatal only if nothing but the driver (or the reflective call into the solution)
            // catches it; the JDK throws and catches exceptions internally all the time.
            Location c = ee.catchLocation();
            String catcher = c == null ? "" : c.declaringType().name();
            boolean fatal = c == null || catcher.startsWith("LvMain") || catcher.startsWith("jdk.internal.reflect") || catcher.startsWith("java.lang.reflect");
            if (!fatal || userFrames(ee.thread()).isEmpty()) continue;
            String msg = exceptionText(ee.exception());
            List<StackFrame> user = userFrames(ee.thread());
            if (!user.isEmpty()) {
              record(ee.thread(), "exception", null, msg);
              error = msg;
              errorLine = user.get(0).location().lineNumber();
            }
            stopStepping(erm);
            stepping = false;
            for (ExceptionRequest r : new ArrayList<>(erm.exceptionRequests())) erm.deleteEventRequest(r);
          } else if (ev instanceof VMDeathEvent || ev instanceof VMDisconnectEvent) {
            break outer;
          }
        } catch (StepLimit sl) {
          truncated = true;
          try { vm.exit(0); } catch (Exception ignored) { }
          break outer;
        }
      }
      if (resume) {
        try { es.resume(); } catch (VMDisconnectedException e) { break; }
      }
    }
    try { p.waitFor(); } catch (Exception ignored) { }
    t1.join(2000);
    t2.join(2000);
    stdoutSink.close();

    StringBuilder o = new StringBuilder("{\"steps\":[").append(steps).append(']');
    if (truncated) o.append(",\"truncated\":true");
    if (error != null) o.append(",\"error\":").append(json(error));
    if (errorLine != null) o.append(",\"errorLine\":").append(errorLine);
    o.append('}');
    Files.write(Paths.get(outFile), o.toString().getBytes(StandardCharsets.UTF_8));
    System.exit(0);
  }

  static class StepLimit extends RuntimeException { }

  static void stopStepping(EventRequestManager erm) {
    for (StepRequest r : new ArrayList<>(erm.stepRequests())) erm.deleteEventRequest(r);
    for (MethodExitRequest r : new ArrayList<>(erm.methodExitRequests())) erm.deleteEventRequest(r);
  }

  static Thread pump(InputStream in, OutputStream out, boolean count) {
    Thread t = new Thread(() -> {
      byte[] buf = new byte[8192];
      try {
        int n;
        while ((n = in.read(buf)) > 0) {
          out.write(buf, 0, n);
          out.flush();
          if (count) outBytes.addAndGet(n);
        }
      } catch (IOException ignored) { }
    });
    t.setDaemon(true);
    t.start();
    return t;
  }

  static String quote(String s) {
    return s.matches("[\\w./:+=-]+") ? s : "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
  }

  // ------------------------------------------------------------------ frames

  static boolean isUser(Method m) {
    try {
      return userSource.equals(m.declaringType().sourceName()) && !m.isSynthetic() && !m.isBridge();
    } catch (AbsentInformationException e) {
      return false;
    }
  }

  /** Scala `object Solution` has static forwarders in class Solution that call Solution$. */
  static boolean isForwarder(Method m) {
    return m.isStatic() && m.declaringType().name().equals("Solution") && userSource.endsWith(".scala");
  }

  static List<StackFrame> userFrames(ThreadReference th) {
    List<StackFrame> out = new ArrayList<>();
    try {
      for (StackFrame f : th.frames()) {
        Location l = f.location();
        Method m = l.method();
        if (isUser(m) && !isForwarder(m) && l.lineNumber() > 0) out.add(f);
      }
    } catch (IncompatibleThreadStateException e) { }
    return out; // innermost first
  }

  static String fnName(Method m) {
    String n = m.name();
    if (n.startsWith("lambda$") || n.contains("$lambda") || n.startsWith("$anonfun")) return "lambda";
    int d = n.indexOf('$');
    return d > 0 ? n.substring(0, d) : n;
  }

  static void record(ThreadReference th, String event, String ret, String exc) {
    if (stepCount >= maxSteps) throw new StepLimit();
    List<StackFrame> frames = userFrames(th);
    if (frames.isEmpty()) return;
    // Kotlin inline functions (let, apply, ...) report lines of the library's file: skip those.
    try {
      if (!userSource.equals(frames.get(0).location().sourceName()) && exc == null && ret == null) return;
    } catch (AbsentInformationException e) {
      return;
    }
    int depth = frames.size();
    StringBuilder stack = new StringBuilder("[");
    for (int i = depth - 1; i >= 0; i--) {
      StackFrame f = frames.get(i);
      Location l = f.location();
      if (i < depth - 1) stack.append(',');
      stack.append("{\"fn\":").append(json(fnName(l.method()))).append(",\"line\":").append(l.lineNumber());
      if (i < FULL_FRAMES) stack.append(",\"locals\":").append(locals(f));
      stack.append('}');
    }
    stack.append(']');
    int line = frames.get(0).location().lineNumber();
    if (stepCount > 0) steps.append(',');
    steps.append("{\"line\":").append(line).append(",\"event\":\"").append(event).append("\",\"stack\":").append(stack)
        .append(",\"out\":").append(outBytes.get());
    if (ret != null) steps.append(",\"ret\":").append(ret);
    if (exc != null) steps.append(",\"exc\":").append(json(exc));
    steps.append('}');
    stepCount++;
    lastDepth = event.equals("return") ? depth - 1 : depth;
  }

  static String locals(StackFrame f) {
    StringBuilder o = new StringBuilder("{");
    boolean first = true;
    try {
      for (LocalVariable v : f.visibleVariables()) {
        String name = v.name();
        if (name.contains("$") || name.startsWith("this")) continue;
        Value val;
        try {
          val = f.getValue(v);
        } catch (RuntimeException e) {
          continue; // e.g. InconsistentDebugInfoException in a compiler-generated catch handler
        }
        if (!first) o.append(',');
        first = false;
        o.append(json(name)).append(':').append(ser(val, 0));
      }
    } catch (AbsentInformationException | RuntimeException e) {
      // compiled without -g, or a frame the VM can't describe: nothing to show
    }
    try {
      ObjectReference self = f.thisObject();
      if (self != null) {
        for (Field fld : self.referenceType().fields()) {
          if (fld.isStatic() || fld.isSynthetic() || fld.name().contains("$")) continue;
          if (!first) o.append(',');
          first = false;
          o.append(json(fld.name())).append(':').append(ser(self.getValue(fld), 0));
        }
      }
    } catch (Exception ignored) { }
    return o.append('}').toString();
  }

  // ------------------------------------------------------------------ values

  static String exceptionText(ObjectReference ex) {
    String cls = ex.referenceType().name();
    cls = cls.substring(cls.lastIndexOf('.') + 1);
    Value msg = field(ex, "detailMessage");
    String m = msg instanceof StringReference ? ((StringReference) msg).value() : null;
    if (cls.equals("StackOverflowError")) return "StackOverflowError (recursion too deep — missing base case?)";
    return cls + (m != null ? ": " + m : "");
  }

  static Value field(ObjectReference o, String name) {
    ReferenceType t = o.referenceType();
    Field f = t.fieldByName(name);
    if (f == null && t instanceof ClassType) {
      for (ClassType c = ((ClassType) t).superclass(); c != null && f == null; c = c.superclass()) f = c.fieldByName(name);
    }
    return f == null ? null : o.getValue(f);
  }

  static int intField(ObjectReference o, String name) {
    Value v = field(o, name);
    return v instanceof PrimitiveValue ? ((PrimitiveValue) v).intValue() : 0;
  }

  static String prim(String v, String k) {
    return "{\"t\":\"prim\",\"v\":" + json(v) + (k != null ? ",\"k\":\"" + k + "\"" : "") + "}";
  }

  static String num(long n) {
    return "{\"t\":\"prim\",\"v\":\"" + n + "\",\"k\":\"num\"" + (Math.abs(n) < (1L << 53) ? ",\"num\":" + n : "") + "}";
  }

  static String strVal(String s) {
    return "{\"t\":\"str\",\"v\":" + json(s.length() > 300 ? s.substring(0, 300) : s) + ",\"more\":" + (s.length() > 300) + "}";
  }

  static String shortText(Value v) {
    if (v == null) return "null";
    if (v instanceof StringReference) return "\"" + ((StringReference) v).value() + "\"";
    if (v instanceof CharValue) return "'" + ((CharValue) v).value() + "'";
    if (v instanceof PrimitiveValue) return v.toString();
    ObjectReference o = (ObjectReference) v;
    String boxed = boxedText(o);
    if (boxed != null) return boxed;
    String n = o.referenceType().name();
    return n.substring(n.lastIndexOf('.') + 1);
  }

  static String boxedText(ObjectReference o) {
    switch (o.referenceType().name()) {
      case "java.lang.Integer": case "java.lang.Long": case "java.lang.Short": case "java.lang.Byte":
      case "java.lang.Double": case "java.lang.Float": case "java.lang.Boolean":
        return String.valueOf(field(o, "value"));
      case "java.lang.Character":
        return "'" + ((CharValue) field(o, "value")).value() + "'";
      default:
        return null;
    }
  }

  static String ser(Value v, int depth) {
    try {
      return serInner(v, depth);
    } catch (Exception e) {
      return prim("?", null);
    }
  }

  static List<Value> arrayItems(ArrayReference arr, int from, int n) {
    n = Math.max(0, Math.min(n, arr.length() - from));
    return n == 0 ? Collections.emptyList() : arr.getValues(from, n);
  }

  static String list(String kind, long id, int len, List<Value> items, int depth) {
    StringBuilder o = new StringBuilder("{\"t\":\"list\",\"kind\":").append(json(kind)).append(",\"id\":").append(id)
        .append(",\"len\":").append(len).append(",\"items\":[");
    for (int i = 0; i < items.size() && i < MAX_ITEMS; i++) { if (i > 0) o.append(','); o.append(ser(items.get(i), depth + 1)); }
    return o.append("]}").toString();
  }

  static String set(int len, List<Value> items, int depth) {
    StringBuilder o = new StringBuilder("{\"t\":\"set\",\"len\":").append(len).append(",\"items\":[");
    for (int i = 0; i < items.size() && i < MAX_ITEMS; i++) { if (i > 0) o.append(','); o.append(ser(items.get(i), depth + 1)); }
    return o.append("]}").toString();
  }

  static String dict(String kind, int len, List<Value[]> entries, int depth) {
    StringBuilder o = new StringBuilder("{\"t\":\"dict\",\"kind\":").append(json(kind)).append(",\"len\":").append(len).append(",\"entries\":[");
    for (int i = 0; i < entries.size() && i < MAX_ITEMS; i++) {
      if (i > 0) o.append(',');
      o.append('[').append(json(shortText(entries.get(i)[0]))).append(',').append(ser(entries.get(i)[1], depth + 1)).append(']');
    }
    return o.append("]}").toString();
  }

  static String serInner(Value v, int depth) {
    if (v == null) return prim("null", "null");
    if (v instanceof BooleanValue) return prim(String.valueOf(((BooleanValue) v).value()), "bool");
    if (v instanceof CharValue) return strVal(String.valueOf(((CharValue) v).value()));
    if (v instanceof DoubleValue || v instanceof FloatValue) return "{\"t\":\"prim\",\"v\":" + json(v.toString()) + ",\"k\":\"num\"}";
    if (v instanceof PrimitiveValue) return num(((PrimitiveValue) v).longValue());
    if (v instanceof StringReference) return strVal(((StringReference) v).value());
    ObjectReference o = (ObjectReference) v;
    String type = o.referenceType().name();
    String boxed = boxedText(o);
    if (boxed != null) {
      if (type.equals("java.lang.Character")) return strVal(boxed.substring(1, boxed.length() - 1));
      if (type.equals("java.lang.Boolean")) return prim(boxed, "bool");
      if (type.equals("java.lang.Double") || type.equals("java.lang.Float")) return prim(boxed, "num");
      return num(Long.parseLong(boxed));
    }
    String simple = type.substring(type.lastIndexOf('.') + 1);
    if (simple.equals("ListNode")) return linkedList(o);
    if (simple.equals("TreeNode")) return tree(o);
    if (v instanceof ArrayReference) {
      ArrayReference arr = (ArrayReference) v;
      if (depth >= MAX_DEPTH) return prim("[" + arr.length() + " items]", null);
      return list("array", o.uniqueID(), arr.length(), arrayItems(arr, 0, MAX_ITEMS), depth);
    }
    if (depth >= MAX_DEPTH) return prim(simple, null);
    switch (type) {
      case "java.util.ArrayList": case "java.util.Vector": case "java.util.Stack": {
        boolean vec = !type.equals("java.util.ArrayList");
        int size = intField(o, vec ? "elementCount" : "size");
        ArrayReference data = (ArrayReference) field(o, "elementData");
        return list(type.equals("java.util.Stack") ? "stack" : simple, o.uniqueID(), size, data == null ? List.of() : arrayItems(data, 0, Math.min(size, MAX_ITEMS)), depth);
      }
      case "java.util.Arrays$ArrayList": case "java.util.ImmutableCollections$ListN": {
        ArrayReference data = (ArrayReference) field(o, type.endsWith("ListN") ? "elements" : "a");
        return list("List", o.uniqueID(), data.length(), arrayItems(data, 0, MAX_ITEMS), depth);
      }
      case "java.util.ImmutableCollections$List12": {
        List<Value> items = new ArrayList<>();
        items.add(field(o, "e0"));
        Value e1 = field(o, "e1");
        if (e1 != null && !(e1 instanceof ObjectReference && ((ObjectReference) e1).referenceType().name().equals("java.lang.Object"))) items.add(e1);
        return list("List", o.uniqueID(), items.size(), items, depth);
      }
      case "java.util.LinkedList": {
        int size = intField(o, "size");
        List<Value> items = new ArrayList<>();
        for (Value n = field(o, "first"); n instanceof ObjectReference && items.size() < MAX_ITEMS; n = field((ObjectReference) n, "next")) items.add(field((ObjectReference) n, "item"));
        return list("deque", o.uniqueID(), size, items, depth);
      }
      case "java.util.ArrayDeque": {
        ArrayReference els = (ArrayReference) field(o, "elements");
        int head = intField(o, "head"), tail = intField(o, "tail"), cap = els.length();
        int size = ((tail - head) % cap + cap) % cap;
        List<Value> items = new ArrayList<>();
        for (int i = 0; i < size && i < MAX_ITEMS; i++) items.add(els.getValue((head + i) % cap));
        return list("deque", o.uniqueID(), size, items, depth);
      }
      case "java.util.PriorityQueue": {
        int size = intField(o, "size");
        ArrayReference q = (ArrayReference) field(o, "queue");
        return list("heap", o.uniqueID(), size, arrayItems(q, 0, Math.min(size, MAX_ITEMS)), depth);
      }
      case "java.util.HashMap": case "java.util.LinkedHashMap": case "java.util.Hashtable":
        return dict(simple, intField(o, type.endsWith("Hashtable") ? "count" : "size"), hashEntries(o, type.endsWith("LinkedHashMap")), depth);
      case "java.util.TreeMap":
        return dict("TreeMap", intField(o, "size"), treeEntries(o), depth);
      case "java.util.HashSet": case "java.util.LinkedHashSet": {
        ObjectReference m = (ObjectReference) field(o, "map");
        List<Value> keys = new ArrayList<>();
        for (Value[] e : hashEntries(m, m.referenceType().name().endsWith("LinkedHashMap"))) keys.add(e[0]);
        return set(intField(m, "size"), keys, depth);
      }
      case "java.util.TreeSet": {
        ObjectReference m = (ObjectReference) field(o, "m");
        List<Value> keys = new ArrayList<>();
        for (Value[] e : treeEntries(m)) keys.add(e[0]);
        return set(intField(m, "size"), keys, depth);
      }
      case "java.lang.StringBuilder": case "java.lang.StringBuffer":
        return strVal(stringBuilderText(o));
      case "scala.collection.immutable.$colon$colon": case "scala.collection.immutable.Nil$": {
        List<Value> items = new ArrayList<>();
        int len = 0;
        for (Value n = v; n instanceof ObjectReference && ((ObjectReference) n).referenceType().name().endsWith("$colon$colon"); n = field((ObjectReference) n, "next"), len++) {
          if (items.size() < MAX_ITEMS) items.add(field((ObjectReference) n, "head"));
          if (len > 100000) break;
        }
        return list("List", o.uniqueID(), len, items, depth);
      }
      case "scala.collection.mutable.ArrayBuffer": case "scala.collection.mutable.Stack": case "scala.collection.mutable.Queue": case "scala.collection.mutable.ArrayDeque": {
        ArrayReference arr = (ArrayReference) field(o, "array");
        int start = type.endsWith("ArrayBuffer") ? 0 : intField(o, "start");
        int size = type.endsWith("ArrayBuffer") ? intField(o, "size0") : ((intField(o, "end") - start) % arr.length() + arr.length()) % arr.length();
        List<Value> items = new ArrayList<>();
        for (int i = 0; i < size && i < MAX_ITEMS; i++) items.add(arr.getValue((start + i) % arr.length()));
        return list(type.endsWith("Stack") ? "stack" : type.endsWith("ArrayBuffer") ? "ArrayBuffer" : "deque", o.uniqueID(), size, items, depth);
      }
      case "scala.collection.mutable.HashMap": {
        List<Value[]> entries = new ArrayList<>();
        ArrayReference table = (ArrayReference) field(o, "scala$collection$mutable$HashMap$$table");
        if (table == null) table = (ArrayReference) field(o, "table");
        if (table != null) {
          for (Value b : table.getValues()) {
            for (Value n = b; n instanceof ObjectReference && entries.size() < MAX_ITEMS; n = field((ObjectReference) n, "_next")) {
              entries.add(new Value[] { field((ObjectReference) n, "_key"), field((ObjectReference) n, "_value") });
            }
          }
        }
        return dict("HashMap", intField(o, "contentSize"), entries, depth);
      }
      case "scala.collection.mutable.HashSet": {
        List<Value> keys = new ArrayList<>();
        ArrayReference table = (ArrayReference) field(o, "scala$collection$mutable$HashSet$$table");
        if (table == null) table = (ArrayReference) field(o, "table");
        if (table != null) {
          for (Value b : table.getValues()) {
            for (Value n = b; n instanceof ObjectReference && keys.size() < MAX_ITEMS; n = field((ObjectReference) n, "_next")) keys.add(field((ObjectReference) n, "_key"));
          }
        }
        return set(intField(o, "contentSize"), keys, depth);
      }
      default:
        break;
    }
    if (type.startsWith("java.") || type.startsWith("scala.") || type.startsWith("kotlin.")) {
      if (type.contains("Lambda") || type.contains("$$")) return prim("<lambda>", null);
      return prim(simple, null);
    }
    // A user-defined object: show its fields.
    StringBuilder b = new StringBuilder("{\"t\":\"obj\",\"cls\":").append(json(simple)).append(",\"fields\":{");
    int k = 0;
    for (Field fld : o.referenceType().allFields()) {
      if (fld.isStatic() || fld.name().contains("$") || k >= 30) continue;
      if (k++ > 0) b.append(',');
      b.append(json(fld.name())).append(':').append(ser(o.getValue(fld), depth + 1));
    }
    return b.append("}}").toString();
  }

  static String stringBuilderText(ObjectReference o) {
    ArrayReference val = (ArrayReference) field(o, "value");
    int count = intField(o, "count");
    Value coder = field(o, "coder");
    boolean utf16 = coder instanceof ByteValue && ((ByteValue) coder).value() != 0;
    StringBuilder s = new StringBuilder();
    List<Value> bytes = arrayItems(val, 0, Math.min(utf16 ? count * 2 : count, 600));
    if (val.referenceType().name().equals("char[]")) {
      for (Value c : bytes) s.append(((CharValue) c).value());
    } else if (!utf16) {
      for (Value c : bytes) s.append((char) (((ByteValue) c).value() & 0xFF));
    } else {
      for (int i = 0; i + 1 < bytes.size(); i += 2) {
        int lo = ((ByteValue) bytes.get(i)).value() & 0xFF, hi = ((ByteValue) bytes.get(i + 1)).value() & 0xFF;
        s.append((char) (lo | (hi << 8)));
      }
    }
    return s.toString();
  }

  static List<Value[]> hashEntries(ObjectReference map, boolean linked) {
    List<Value[]> out = new ArrayList<>();
    if (linked) {
      for (Value n = field(map, "head"); n instanceof ObjectReference && out.size() < MAX_ITEMS; n = field((ObjectReference) n, "after")) {
        out.add(new Value[] { field((ObjectReference) n, "key"), field((ObjectReference) n, "value") });
      }
      return out;
    }
    Value t = field(map, "table");
    if (!(t instanceof ArrayReference)) return out;
    for (Value b : ((ArrayReference) t).getValues()) {
      for (Value n = b; n instanceof ObjectReference && out.size() < MAX_ITEMS; n = field((ObjectReference) n, "next")) {
        out.add(new Value[] { field((ObjectReference) n, "key"), field((ObjectReference) n, "value") });
      }
    }
    return out;
  }

  static List<Value[]> treeEntries(ObjectReference map) {
    List<Value[]> out = new ArrayList<>();
    inorder(field(map, "root"), out);
    return out;
  }

  static void inorder(Value n, List<Value[]> out) {
    if (!(n instanceof ObjectReference) || out.size() >= MAX_ITEMS) return;
    ObjectReference e = (ObjectReference) n;
    inorder(field(e, "left"), out);
    if (out.size() < MAX_ITEMS) out.add(new Value[] { field(e, "key"), field(e, "value") });
    inorder(field(e, "right"), out);
  }

  static Value nodeVal(ObjectReference n) {
    Value v = field(n, "val");
    if (v == null) v = field(n, "x");
    if (v == null) v = field(n, "value");
    return v;
  }

  static String linkedList(ObjectReference head) {
    StringBuilder o = new StringBuilder("{\"t\":\"llist\",\"nodes\":[");
    Map<Long, Integer> seen = new HashMap<>();
    Integer cycle = null;
    Value cur = head;
    int k = 0;
    while (cur instanceof ObjectReference && k < 60) {
      ObjectReference n = (ObjectReference) cur;
      if (seen.containsKey(n.uniqueID())) { cycle = seen.get(n.uniqueID()); break; }
      seen.put(n.uniqueID(), k);
      if (k > 0) o.append(',');
      o.append("{\"id\":").append(n.uniqueID()).append(",\"val\":").append(json(shortText(nodeVal(n)))).append('}');
      cur = field(n, "next");
      k++;
    }
    boolean more = cur instanceof ObjectReference && cycle == null;
    return o.append("],\"cycle\":").append(cycle).append(",\"more\":").append(more).append('}').toString();
  }

  static String tree(ObjectReference root) {
    StringBuilder o = new StringBuilder("{\"t\":\"tree\",\"root\":\"").append(root.uniqueID()).append("\",\"nodes\":{");
    ArrayDeque<ObjectReference> q = new ArrayDeque<>();
    Set<Long> seen = new HashSet<>();
    q.add(root);
    int k = 0;
    while (!q.isEmpty() && k < 63) {
      ObjectReference n = q.poll();
      if (!seen.add(n.uniqueID())) continue;
      Value l = field(n, "left"), r = field(n, "right");
      if (k++ > 0) o.append(',');
      o.append('"').append(n.uniqueID()).append("\":{\"val\":").append(json(shortText(nodeVal(n))))
          .append(",\"l\":").append(l instanceof ObjectReference ? "\"" + ((ObjectReference) l).uniqueID() + "\"" : "null")
          .append(",\"r\":").append(r instanceof ObjectReference ? "\"" + ((ObjectReference) r).uniqueID() + "\"" : "null").append('}');
      if (l instanceof ObjectReference) q.add((ObjectReference) l);
      if (r instanceof ObjectReference) q.add((ObjectReference) r);
    }
    return o.append("}}").toString();
  }

  static String json(String s) {
    StringBuilder b = new StringBuilder("\"");
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      if (c == '"' || c == '\\') b.append('\\').append(c);
      else if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
      else b.append(c);
    }
    return b.append('"').toString();
  }
}
