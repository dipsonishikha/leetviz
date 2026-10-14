def gen(n, stress=False):
    hi = max(10, n) if stress else max(100, 4 * n)
    nums = [random.randint(-hi, hi) for _ in range(n)]
    target = random.randint(-2 * hi, 2 * hi) if stress else 3 * hi + 1
    return [nums, target]
