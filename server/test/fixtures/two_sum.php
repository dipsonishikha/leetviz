class Solution {

    /**
     * @param Integer[] $nums
     * @param Integer $target
     * @return Integer[]
     */
    function twoSum($nums, $target) {
        $seen = [];
        foreach ($nums as $i => $x) {
            $need = $target - $x;
            if (isset($seen[$need])) return [$seen[$need], $i];
            $seen[$x] = $i;
        }
        echo "none\n";
        return [];
    }
}
