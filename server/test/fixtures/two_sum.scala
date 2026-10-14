object Solution {
    def twoSum(nums: Array[Int], target: Int): Array[Int] = {
        val seen = scala.collection.mutable.HashMap[Int, Int]()
        for (i <- nums.indices) {
            val need = target - nums(i)
            if (seen.contains(need)) return Array(seen(need), i)
            seen(nums(i)) = i
        }
        Array()
    }
}
