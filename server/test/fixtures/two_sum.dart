class Solution {
  List<int> twoSum(List<int> nums, int target) {
    final seen = <int, int>{};
    for (var i = 0; i < nums.length; i++) {
      final need = target - nums[i];
      if (seen.containsKey(need)) {
        return [seen[need]!, i];
      }
      seen[nums[i]] = i;
    }
    return [];
  }
}
