# @param {Integer[]} nums
# @param {Integer} target
# @return {Integer[]}
def two_sum(nums, target)
    seen = {}
    nums.each_with_index do |x, i|
        need = target - x
        return [seen[need], i] if seen.key?(need)
        seen[x] = i
    end
    []
end
