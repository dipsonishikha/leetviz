# LeetCode's ListNode / TreeNode for Elixir solutions.
defmodule ListNode do
  @type t :: %__MODULE__{val: integer, next: ListNode.t() | nil}
  defstruct val: 0, next: nil
end

defmodule TreeNode do
  @type t :: %__MODULE__{val: integer, left: TreeNode.t() | nil, right: TreeNode.t() | nil}
  defstruct val: 0, left: nil, right: nil
end
