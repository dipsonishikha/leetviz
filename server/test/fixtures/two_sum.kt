class Solution {
    fun twoSum(nums: IntArray, target: Int): IntArray {
        val seen = HashMap<Int, Int>()
        for ((i, x) in nums.withIndex()) {
            val need = target - x
            seen[need]?.let { return intArrayOf(it, i) }
            seen[x] = i
        }
        return intArrayOf()
    }
}
