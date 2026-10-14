// LeetCode's Java environment offers javafx.util.Pair; this stand-in has the same API.
package javafx.util;

public class Pair<K, V> {
  private final K key;
  private final V value;
  public Pair(K key, V value) { this.key = key; this.value = value; }
  public K getKey() { return key; }
  public V getValue() { return value; }
  @Override public boolean equals(Object o) {
    return o instanceof Pair && java.util.Objects.equals(key, ((Pair<?, ?>) o).key) && java.util.Objects.equals(value, ((Pair<?, ?>) o).value);
  }
  @Override public int hashCode() { return java.util.Objects.hashCode(key) * 13 + java.util.Objects.hashCode(value); }
  @Override public String toString() { return key + "=" + value; }
}
