defmodule Solution do
  @spec two_sum(nums :: [integer], target :: integer) :: [integer]
  def two_sum(nums, target) do
    find(nums, target, 0, %{})
  end

  defp find([], _target, _i, _seen), do: []

  defp find([x | rest], target, i, seen) do
    case Map.fetch(seen, target - x) do
      {:ok, j} -> [j, i]
      :error -> find(rest, target, i + 1, Map.put(seen, x, i))
    end
  end
end
