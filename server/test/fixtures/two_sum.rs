use std::collections::HashMap;

impl Solution {
    pub fn two_sum(nums: Vec<i32>, target: i32) -> Vec<i32> {
        let mut seen: HashMap<i32, i32> = HashMap::new();
        let name = String::from("abc");
        for (i, &x) in nums.iter().enumerate() {
            if let Some(&j) = seen.get(&(target - x)) {
                return vec![j, i as i32];
            }
            seen.insert(x, i as i32);
        }
        vec![]
    }
}
