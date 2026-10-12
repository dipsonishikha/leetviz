// Used when panel.html is opened directly (not inside LeetCode) — handy for trying LeetViz out
// and for developing the panel without a LeetCode tab.

const OPTIMAL = `class Solution:
    def twoSum(self, nums: List[int], target: int) -> List[int]:
        seen = {}
        for i, x in enumerate(nums):
            need = target - x
            if need in seen:
                return [seen[need], i]
            seen[x] = i
        return []
`;

const BRUTE = `class Solution:
    def twoSum(self, nums: List[int], target: int) -> List[int]:
        n = len(nums)
        for i in range(n):
            for j in range(i + 1, n):
                if nums[i] + nums[j] == target:
                    return [i, j]
        return []
`;

const SORTED = `class Solution:
    def twoSum(self, nums: List[int], target: int) -> List[int]:
        order = sorted(range(len(nums)), key=lambda k: nums[k])
        left, right = 0, len(nums) - 1
        while left < right:
            total = nums[order[left]] + nums[order[right]]
            if total == target:
                return sorted([order[left], order[right]])
            if total < target:
                left += 1
            else:
                right -= 1
        return []
`;

export const DEMO = {
  context: {
    slug: 'demo-two-sum',
    title: 'Demo · 1. Two Sum',
    code: OPTIMAL,
    lang: 'python',
    hasMonaco: true,
    meta: {
      name: 'twoSum',
      params: [{ name: 'nums', type: 'integer[]' }, { name: 'target', type: 'integer' }],
      return: { type: 'integer[]' },
    },
    examples: [[[2, 7, 11, 15], 9], [[3, 2, 4], 6], [[3, 3], 6]],
    constraintN: 10000,
    dark: matchMedia('(prefers-color-scheme: dark)').matches,
  },
  approaches: [
    { id: 'demo-brute', name: 'Brute force', code: BRUTE },
    { id: 'demo-sorted', name: 'Sort + two pointers', code: SORTED },
  ],
};
