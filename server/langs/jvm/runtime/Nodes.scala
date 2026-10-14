// LeetCode's ListNode / TreeNode for Scala solutions (note the field names: x and value).
class ListNode(_x: Int = 0, _next: ListNode = null) {
  var next: ListNode = _next
  var x: Int = _x
}
class TreeNode(_value: Int = 0, _left: TreeNode = null, _right: TreeNode = null) {
  var value: Int = _value
  var left: TreeNode = _left
  var right: TreeNode = _right
}
