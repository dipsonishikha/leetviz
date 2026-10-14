class Solution {
    func twoSum(_ nums: [Int], _ target: Int) -> [Int] {
        var seen = [Int: Int]()
        for (i, x) in nums.enumerated() {
            let need = target - x
            if let j = seen[need] {
                return [j, i]
            }
            seen[x] = i
        }
        return []
    }
}
