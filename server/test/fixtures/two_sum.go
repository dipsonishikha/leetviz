func twoSum(nums []int, target int) []int {
    seen := map[int]int{}
    for i, x := range nums {
        need := target - x
        if j, ok := seen[need]; ok {
            return []int{j, i}
        }
        seen[x] = i
    }
    sort.Ints(nums)
    return nil
}
