// Values in the LeetViz trace format. The tracer calls lvSer(x) inside paused frames (the
// solution file imports this library on line 1), and the driver uses lvPlain() for results.
import 'dart:collection';
import 'dart:convert';
import 'nodes.dart';

const _maxItems = 120;
const _maxDepth = 3;
final _ids = Expando<int>();
var _nextId = 1;
int _id(Object o) => _ids[o] ??= _nextId++;

String _short(Object? v) {
  final s = v is String ? jsonEncode(v) : v is ListNode ? '${v.val}' : v is TreeNode ? '${v.val}' : '$v';
  return s.length <= 80 ? s : '${s.substring(0, 77)}...';
}

Map<String, Object?> lvValue(Object? v, [int depth = 0]) {
  if (v == null) return {'t': 'prim', 'v': 'null', 'k': 'null'};
  if (v is bool) return {'t': 'prim', 'v': '$v', 'k': 'bool'};
  if (v is int) return {'t': 'prim', 'v': '$v', 'k': 'num', if (v.abs() < 9007199254740992) 'num': v};
  if (v is double) return {'t': 'prim', 'v': '$v', 'k': 'num'};
  if (v is String) return {'t': 'str', 'v': v.length > 300 ? v.substring(0, 300) : v, 'more': v.length > 300};
  if (v is ListNode) {
    final nodes = <Map<String, Object?>>[];
    final seen = Map<ListNode, int>.identity();
    int? cycle;
    ListNode? cur = v;
    while (cur != null && nodes.length < 60) {
      if (seen.containsKey(cur)) { cycle = seen[cur]; break; }
      seen[cur] = nodes.length;
      nodes.add({'id': _id(cur), 'val': _short(cur.val)});
      cur = cur.next;
    }
    return {'t': 'llist', 'nodes': nodes, 'cycle': cycle, 'more': cur != null && cycle == null};
  }
  if (v is TreeNode) {
    final nodes = <String, Object?>{};
    final q = <TreeNode>[v];
    for (var i = 0; i < q.length && nodes.length < 63; i++) {
      final n = q[i];
      if (nodes.containsKey('${_id(n)}')) continue;
      nodes['${_id(n)}'] = {'val': _short(n.val), 'l': n.left == null ? null : '${_id(n.left!)}', 'r': n.right == null ? null : '${_id(n.right!)}'};
      if (n.left != null) q.add(n.left!);
      if (n.right != null) q.add(n.right!);
    }
    return {'t': 'tree', 'root': '${_id(v)}', 'nodes': nodes};
  }
  if (depth >= _maxDepth) return {'t': 'prim', 'v': _short(v)};
  if (v is Map) {
    return {'t': 'dict', 'kind': v.runtimeType.toString().split('<').first, 'len': v.length,
      'entries': v.entries.take(_maxItems).map((e) => [e.key is String ? e.key : _short(e.key), lvValue(e.value, depth + 1)]).toList()};
  }
  if (v is Set) return {'t': 'set', 'len': v.length, 'items': v.take(_maxItems).map((x) => lvValue(x, depth + 1)).toList()};
  if (v is Queue) return {'t': 'list', 'kind': 'deque', 'id': _id(v), 'len': v.length, 'items': v.take(_maxItems).map((x) => lvValue(x, depth + 1)).toList()};
  if (v is Iterable) {
    final items = v.take(_maxItems + 1).toList();
    return {'t': 'list', 'kind': v is List ? 'List' : v.runtimeType.toString().split('<').first, 'id': _id(v), 'len': v is List ? v.length : items.length,
      'items': items.take(_maxItems).map((x) => lvValue(x, depth + 1)).toList()};
  }
  if (v is Function) return {'t': 'prim', 'v': '<function>'};
  return {'t': 'prim', 'v': _short(v)};
}

String lvSer(Object? v) => jsonEncode(lvValue(v));

Object? lvPlain(Object? v) {
  if (v is ListNode) {
    final out = <Object?>[];
    for (ListNode? c = v; c != null && out.length < 100000; c = c.next) out.add(c.val);
    return out;
  }
  if (v is TreeNode) {
    final out = <Object?>[];
    final q = <TreeNode?>[v];
    for (var i = 0; i < q.length && q.length < 400000; i++) {
      final n = q[i];
      if (n == null) { out.add(null); } else { out.add(n.val); q..add(n.left)..add(n.right); }
    }
    while (out.isNotEmpty && out.last == null) out.removeLast();
    return out;
  }
  if (v is Map) return v.map((k, x) => MapEntry('$k', lvPlain(x)));
  if (v is Iterable) return v.map(lvPlain).toList();
  if (v is double && !v.isFinite) return null;
  return v;
}

/// All of a frame's locals in one call: {name: value, ...} as JSON.
String lvSnap(List<String> names, List<Object?> values) {
  final out = <String, Object?>{};
  for (var i = 0; i < names.length; i++) {
    if (values[i] is Function) continue;
    out[names[i]] = lvValue(values[i]);
  }
  return jsonEncode(out);
}
