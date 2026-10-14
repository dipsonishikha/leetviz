// LeetViz driver for JVM languages (Java, Kotlin, Scala).
//
//   java LvMain trace <method> <param types...> -> <return type>   (one input line, prints one result)
//   java LvMain serve <method> <param types...> -> <return type>   (one request per line, see lib/runner.js)
//
// Inputs arrive in the token format of server/lib/types.js and are converted to whatever the
// solution's parameter types are (int[], List<Integer>, a Scala List, ListNode, ...) with
// reflection, so one compiled driver serves every problem and all three languages.
import java.io.*;
import java.lang.management.ManagementFactory;
import java.lang.reflect.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

public class LvMain {
  // ------------------------------------------------------------------ LeetCode types
  static final class LType {
    final String k; final LType of;
    LType(String k, LType of) { this.k = k; this.of = of; }
    static LType parse(String s) {
      s = s.trim();
      if (s.endsWith("[]")) return new LType("array", parse(s.substring(0, s.length() - 2)));
      if (s.startsWith("list<") && s.endsWith(">")) return new LType("list", parse(s.substring(5, s.length() - 1)));
      return new LType(s, null);
    }
    boolean seq() { return of != null; }
  }

  // ------------------------------------------------------------------ reading tokens
  static String[] toks; static int pos;
  static String tok() { return toks[pos++]; }

  static String unpct(String t) {
    ByteArrayOutputStream b = new ByteArrayOutputStream();
    for (int i = 1; i < t.length(); i++) {
      char c = t.charAt(i);
      if (c == '%' && i + 2 < t.length()) { b.write(Integer.parseInt(t.substring(i + 1, i + 3), 16)); i += 2; }
      else b.write((byte) c);
    }
    return new String(b.toByteArray(), StandardCharsets.UTF_8);
  }

  static Class<?> raw(Type t) {
    if (t instanceof Class) return (Class<?>) t;
    if (t instanceof ParameterizedType) return raw(((ParameterizedType) t).getRawType());
    if (t instanceof WildcardType) return raw(((WildcardType) t).getUpperBounds()[0]);
    if (t instanceof GenericArrayType) return Array.newInstance(raw(((GenericArrayType) t).getGenericComponentType()), 0).getClass();
    return Object.class;
  }

  static Type elemType(Type t) {
    if (t instanceof Class && ((Class<?>) t).isArray()) return ((Class<?>) t).getComponentType();
    if (t instanceof GenericArrayType) return ((GenericArrayType) t).getGenericComponentType();
    if (t instanceof ParameterizedType) {
      Type[] a = ((ParameterizedType) t).getActualTypeArguments();
      if (a.length == 1) return a[0] instanceof WildcardType ? ((WildcardType) a[0]).getUpperBounds()[0] : a[0];
    }
    return Object.class;
  }

  static Object read(LType lt, Type jt) throws Exception {
    Class<?> c = raw(jt);
    switch (lt.k) {
      case "integer": case "int": {
        long v = Long.parseLong(tok());
        if (c == long.class || c == Long.class) return v;
        return (int) v;
      }
      case "long": {
        long v = Long.parseLong(tok());
        if (c == int.class || c == Integer.class) return (int) v;
        return v;
      }
      case "double": return Double.parseDouble(tok());
      case "boolean": return tok().equals("1");
      case "string": return unpct(tok());
      case "character": {
        String s = unpct(tok());
        return s.isEmpty() ? '\0' : s.charAt(0);
      }
      case "ListNode": return readList(c);
      case "TreeNode": return readTree(c);
    }
    if (lt.seq()) {
      int n = Integer.parseInt(tok());
      Type et = elemType(jt);
      if (c.isArray()) {
        Object a = Array.newInstance(c.getComponentType(), n);
        for (int i = 0; i < n; i++) Array.set(a, i, read(lt.of, et));
        return a;
      }
      ArrayList<Object> l = new ArrayList<>(n);
      for (int i = 0; i < n; i++) l.add(read(lt.of, et));
      return toCollection(l, c);
    }
    throw new IllegalArgumentException("unsupported type " + lt.k);
  }

  /** java.util.List for Java/Kotlin; Scala collections are built from it with Scala's converters. */
  static Object toCollection(ArrayList<Object> l, Class<?> c) throws Exception {
    String name = c.getName();
    if (name.startsWith("scala.")) {
      Class<?> conv = Class.forName("scala.jdk.javaapi.CollectionConverters");
      Object buf = conv.getMethod("asScala", java.util.List.class).invoke(null, l);
      if (name.contains("immutable.List") || name.equals("scala.collection.immutable.Seq") || name.equals("scala.collection.Seq")) return buf.getClass().getMethod("toList").invoke(buf);
      if (name.contains("Vector") || name.contains("IndexedSeq")) return buf.getClass().getMethod("toVector").invoke(buf);
      return buf;
    }
    if (c.isAssignableFrom(ArrayList.class)) return l;
    if (c.isAssignableFrom(LinkedList.class)) return new LinkedList<>(l);
    return l;
  }

  static Field field(Class<?> c, String... names) {
    for (String n : names) {
      try { Field f = c.getDeclaredField(n); f.setAccessible(true); return f; } catch (NoSuchFieldException e) { }
    }
    throw new IllegalStateException(c.getName() + " has none of the fields " + Arrays.toString(names));
  }

  static Object newNode(Class<?> c, int v) throws Exception {
    for (Constructor<?> k : c.getDeclaredConstructors()) {
      Class<?>[] p = k.getParameterTypes();
      if (p.length >= 1 && (p[0] == int.class || p[0] == Integer.class)) {
        Object[] args = new Object[p.length];
        args[0] = v;
        k.setAccessible(true);
        return k.newInstance(args);
      }
    }
    Object o = c.getDeclaredConstructor().newInstance();
    field(c, "val", "x", "value").set(o, v);
    return o;
  }

  static Class<?> nodeClass(Class<?> declared, String name) throws ClassNotFoundException {
    return declared != Object.class && declared.getSimpleName().equals(name) ? declared : Class.forName(name);
  }

  static Object readList(Class<?> declared) throws Exception {
    Class<?> c = nodeClass(declared, "ListNode");
    int n = Integer.parseInt(tok());
    Object head = null, cur = null;
    Field next = field(c, "next");
    for (int i = 0; i < n; i++) {
      Object node = newNode(c, Integer.parseInt(tok()));
      if (head == null) head = node; else next.set(cur, node);
      cur = node;
    }
    return head;
  }

  static Object readTree(Class<?> declared) throws Exception {
    Class<?> c = nodeClass(declared, "TreeNode");
    int n = Integer.parseInt(tok());
    String[] t = new String[n];
    for (int i = 0; i < n; i++) t[i] = tok();
    if (n == 0 || t[0].equals("#")) return null;
    Field left = field(c, "left"), right = field(c, "right");
    Object root = newNode(c, Integer.parseInt(t[0]));
    ArrayDeque<Object> q = new ArrayDeque<>();
    q.add(root);
    int i = 1;
    while (!q.isEmpty() && i < n) {
      Object node = q.poll();
      if (i < n && !t[i].equals("#")) { Object l = newNode(c, Integer.parseInt(t[i])); left.set(node, l); q.add(l); }
      i++;
      if (i < n && !t[i].equals("#")) { Object r = newNode(c, Integer.parseInt(t[i])); right.set(node, r); q.add(r); }
      i++;
    }
    return root;
  }

  // ------------------------------------------------------------------ writing JSON
  static void str(StringBuilder o, String s) {
    o.append('"');
    for (int i = 0; i < s.length(); i++) {
      char ch = s.charAt(i);
      if (ch == '"' || ch == '\\') o.append('\\').append(ch);
      else if (ch < 0x20) o.append(String.format("\\u%04x", (int) ch));
      else o.append(ch);
    }
    o.append('"');
  }

  static Object fieldValue(Object node, String... names) throws Exception {
    return field(node.getClass(), names).get(node);
  }

  static void write(StringBuilder o, Object v) throws Exception {
    if (v == null) { o.append("null"); return; }
    if (v instanceof Double || v instanceof Float) {
      double d = ((Number) v).doubleValue();
      if (Double.isNaN(d) || Double.isInfinite(d)) o.append("null");
      else if (d == Math.rint(d) && Math.abs(d) < 1e15) o.append((long) d);
      else o.append(d);
      return;
    }
    if (v instanceof Number || v instanceof Boolean) { o.append(v); return; }
    if (v instanceof Character) { str(o, v.toString()); return; }
    if (v instanceof CharSequence) { str(o, v.toString()); return; }
    Class<?> c = v.getClass();
    if (c.isArray()) {
      o.append('[');
      for (int i = 0, n = Array.getLength(v); i < n; i++) { if (i > 0) o.append(','); write(o, Array.get(v, i)); }
      o.append(']');
      return;
    }
    String sn = c.getSimpleName();
    if (sn.equals("ListNode")) {
      o.append('[');
      int k = 0;
      for (Object cur = v; cur != null && k < 100000; cur = fieldValue(cur, "next"), k++) {
        if (k > 0) o.append(',');
        write(o, fieldValue(cur, "val", "x", "value"));
      }
      o.append(']');
      return;
    }
    if (sn.equals("TreeNode")) {
      ArrayList<Object> q = new ArrayList<>();
      q.add(v);
      ArrayList<String> parts = new ArrayList<>();
      for (int i = 0; i < q.size() && q.size() < 400000; i++) {
        Object node = q.get(i);
        if (node == null) { parts.add("null"); continue; }
        StringBuilder b = new StringBuilder();
        write(b, fieldValue(node, "val", "value", "x"));
        parts.add(b.toString());
        q.add(fieldValue(node, "left"));
        q.add(fieldValue(node, "right"));
      }
      while (!parts.isEmpty() && parts.get(parts.size() - 1).equals("null")) parts.remove(parts.size() - 1);
      o.append('[').append(String.join(",", parts)).append(']');
      return;
    }
    if (v instanceof Iterable) {
      o.append('[');
      boolean first = true;
      for (Object x : (Iterable<?>) v) { if (!first) o.append(','); first = false; write(o, x); }
      o.append(']');
      return;
    }
    if (v instanceof Map) {
      o.append('{');
      boolean first = true;
      for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) { if (!first) o.append(','); first = false; str(o, String.valueOf(e.getKey())); o.append(':'); write(o, e.getValue()); }
      o.append('}');
      return;
    }
    if (c.getName().startsWith("scala.")) {
      // Any Scala collection: walk its iterator.
      try {
        Object it = c.getMethod("iterator").invoke(v);
        Method hasNext = it.getClass().getMethod("hasNext"), next = it.getClass().getMethod("next");
        hasNext.setAccessible(true); next.setAccessible(true);
        o.append('[');
        boolean first = true;
        while ((Boolean) hasNext.invoke(it)) { if (!first) o.append(','); first = false; write(o, next.invoke(it)); }
        o.append(']');
        return;
      } catch (NoSuchMethodException e) { /* fall through */ }
    }
    str(o, v.toString());
  }

  // ------------------------------------------------------------------ calling the solution
  static Method method; static Object receiver; static LType[] ptypes; static boolean isVoid;

  static void setup(String name, List<String> types) throws Exception {
    int arrow = types.indexOf("->");
    List<String> ps = types.subList(0, arrow);
    ptypes = ps.stream().map(LType::parse).toArray(LType[]::new);
    isVoid = types.get(arrow + 1).equals("void");
    // Scala `object Solution` compiles to Solution$ (with static forwarders in Solution).
    Class<?> sol;
    try { sol = Class.forName("Solution$"); } catch (ClassNotFoundException e) { sol = Class.forName("Solution"); }
    for (Method m : sol.getDeclaredMethods()) {
      if (m.getName().equals(name) && m.getParameterCount() == ptypes.length && !m.isBridge() && !m.isSynthetic()) { method = m; break; }
    }
    if (method == null) throw new NoSuchMethodException("Couldn't find " + name + "(" + ptypes.length + " parameters) in class Solution");
    method.setAccessible(true);
    if (Modifier.isStatic(method.getModifiers())) receiver = null;
    else if (sol.getName().equals("Solution$")) receiver = sol.getField("MODULE$").get(null);
    else { Constructor<?> k = sol.getDeclaredConstructor(); k.setAccessible(true); receiver = k; }
  }

  static Object[] readArgs(String line, int from) throws Exception {
    toks = line.trim().isEmpty() ? new String[0] : line.trim().split(" +");
    pos = from;
    Type[] jt = method.getGenericParameterTypes();
    Object[] args = new Object[ptypes.length];
    for (int i = 0; i < args.length; i++) args[i] = read(ptypes[i], jt[i]);
    return args;
  }

  static Object target() throws Exception {
    return receiver instanceof Constructor ? ((Constructor<?>) receiver).newInstance() : receiver;
  }

  static long lastAlloc = -1;
  static final com.sun.management.ThreadMXBean MX = (com.sun.management.ThreadMXBean) ManagementFactory.getThreadMXBean();

  /** One run; returns seconds spent inside the solution. Result JSON goes to out (if non-null). */
  static double once(String line, int from, StringBuilder out) throws Throwable {
    Object[] args = readArgs(line, from);
    Object self = target();
    long a0 = MX.getCurrentThreadAllocatedBytes();
    long t0 = System.nanoTime();
    Object r;
    try {
      r = method.invoke(self, args);
    } catch (InvocationTargetException e) {
      throw e.getCause();
    }
    long t1 = System.nanoTime();
    lastAlloc = MX.getCurrentThreadAllocatedBytes() - a0;
    if (out != null) { out.setLength(0); write(out, isVoid ? args[0] : r); }
    return (t1 - t0) / 1e9;
  }

  static String errorText(Throwable e) {
    if (e instanceof StackOverflowError) return "StackOverflowError (recursion too deep — missing base case?)";
    String m = e.getMessage();
    return e.getClass().getSimpleName() + (m != null ? ": " + m : "");
  }

  public static void main(String[] argv) throws Exception {
    PrintStream proto = new PrintStream(new FileOutputStream(FileDescriptor.out), true, "UTF-8");
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8), 1 << 16);
    try {
      setup(argv[1], Arrays.asList(argv).subList(2, argv.length));
    } catch (Throwable e) {
      proto.println("\u0001LV {\"err\":" + json(errorText(e)) + "}");
      return;
    }
    if (argv[0].equals("trace")) {
      String line = in.readLine();
      StringBuilder out = new StringBuilder();
      try {
        lvTraceRun(line, out);
        System.out.flush();
        proto.println("\n\u0001LV " + out);
      } catch (Throwable e) {
        System.out.flush();
        proto.println("\n\u0001LV {\"err\":" + json(errorText(e)) + "}");
      }
      return;
    }
    String line;
    while ((line = in.readLine()) != null) {
      String[] head = line.trim().split(" +", 4);
      double minTime = Double.parseDouble(head[0]);
      int maxRuns = Integer.parseInt(head[1]);
      StringBuilder out = new StringBuilder();
      try {
        double total = once(line, 3, out);
        int runs = 1;
        long alloc = lastAlloc;
        if (maxRuns > 1 && total < 0.05) {
          // Let the JIT compile the hot code before timing, like LeetCode's many test cases do.
          long warm = System.nanoTime();
          while (System.nanoTime() - warm < 150_000_000L) once(line, 3, null);
          total = 0; runs = 0;
        }
        while (runs < maxRuns && (runs == 0 || total < minTime)) { total += once(line, 3, out); runs++; }
        proto.println("\u0001LV {\"t\":" + (total / runs) + ",\"runs\":" + runs + ",\"mem\":" + alloc + ",\"depth\":-1,\"out\":" + out + "}");
      } catch (Throwable e) {
        proto.println("\u0001LV {\"err\":" + json(errorText(e)) + "}");
      }
    }
  }

  /** The traced run: the tracer puts its first breakpoint inside the solution method. */
  static void lvTraceRun(String line, StringBuilder out) throws Throwable {
    once(line, 0, out);
  }

  static String json(String s) {
    StringBuilder b = new StringBuilder();
    str(b, s);
    return b.toString();
  }
}
