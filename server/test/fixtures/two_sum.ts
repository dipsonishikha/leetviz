function twoSum(nums: number[], target: number): number[] {
    const seen: Record<number, number> = {};
    for (let i = 0; i < nums.length; i++) {
        const need: number = target - nums[i];
        if (need in seen) return [seen[need], i];
        seen[nums[i]] = i;
    }
    return [];
};
