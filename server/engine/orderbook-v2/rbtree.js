// ═══════════════════════════════════════════════════════════════════════
// Red-Black Tree — Self-balancing BST with guaranteed O(log n) operations
// Zero-dependency implementation for order book price level management
//
// Properties:
//   1. Every node is RED or BLACK
//   2. Root is always BLACK
//   3. NULL leaves are BLACK
//   4. RED node's children are both BLACK
//   5. Every root→leaf path has the same black-node count
//
// Operations:
//   insert  O(log n)     find      O(log n)
//   remove  O(log n)     min/max   O(log n)
//   forEach O(n)         firstN    O(k log n)
// ═══════════════════════════════════════════════════════════════════════

const RED   = true
const BLACK = false

class RBNode {
  constructor(key, value) {
    this.key    = key
    this.value  = value
    this.color  = RED
    this.left   = null
    this.right  = null
    this.parent = null
  }
}

export class RBTree {
  /**
   * @param {function} [comparator] (a, b) => number. Default: numeric ascending.
   */
  constructor(comparator) {
    this.root    = null
    this._size   = 0
    this.compare = comparator || ((a, b) => a - b)
  }

  get size() { return this._size }

  /* ═══════ PUBLIC API ═══════════════════════════════════════════════ */

  /**
   * Insert key-value pair.
   * If key already exists, updates value and returns old value.
   * Otherwise inserts new node and returns null.
   */
  insert(key, value) {
    let parent  = null
    let current = this.root

    while (current) {
      parent = current
      const cmp = this.compare(key, current.key)
      if (cmp === 0) {
        const old = current.value
        current.value = value
        return old
      }
      current = cmp < 0 ? current.left : current.right
    }

    const node = new RBNode(key, value)
    node.parent = parent
    this._size++

    if (!parent) {
      this.root = node
    } else if (this.compare(key, parent.key) < 0) {
      parent.left = node
    } else {
      parent.right = node
    }

    this._fixInsert(node)
    return null
  }

  /**
   * Remove node by key.
   * Returns removed value, or null if key not found.
   */
  remove(key) {
    const z = this._findNode(key)
    if (!z) return null

    const value = z.value
    this._deleteNode(z)
    this._size--
    return value
  }

  /** Find value by key. Returns value or null. */
  find(key) {
    const node = this._findNode(key)
    return node ? node.value : null
  }

  /** Minimum key-value pair, or null if empty. */
  min() {
    const node = this._minNode(this.root)
    return node ? { key: node.key, value: node.value } : null
  }

  /** Maximum key-value pair, or null if empty. */
  max() {
    const node = this._maxNode(this.root)
    return node ? { key: node.key, value: node.value } : null
  }

  /** In-order traversal (ascending). callback(key, value). */
  forEach(callback) {
    this._inOrder(this.root, callback)
  }

  /** Reverse in-order traversal (descending). callback(key, value). */
  forEachDesc(callback) {
    this._reverseInOrder(this.root, callback)
  }

  /**
   * Get first N items.
   * @param {number} n
   * @param {boolean} [reverse=false] If true, return from max descending.
   * @returns {{key, value}[]}
   */
  firstN(n, reverse = false) {
    const result = []
    if (reverse) {
      this._reverseInOrderN(this.root, result, n)
    } else {
      this._inOrderN(this.root, result, n)
    }
    return result
  }

  /** Iterate all nodes with key >= given key, ascending. callback(key, value). */
  forEachGE(key, callback) {
    this._scanGE(this.root, key, callback)
  }

  /** Iterate all nodes with key <= given key, ascending. callback(key, value). */
  forEachLE(key, callback) {
    this._scanLE(this.root, key, callback)
  }

  /* ═══════ INTERNAL: FIND ═════════════════════════════════════════ */

  _findNode(key) {
    let current = this.root
    while (current) {
      const cmp = this.compare(key, current.key)
      if (cmp === 0) return current
      current = cmp < 0 ? current.left : current.right
    }
    return null
  }

  _minNode(node) {
    if (!node) return null
    while (node.left) node = node.left
    return node
  }

  _maxNode(node) {
    if (!node) return null
    while (node.right) node = node.right
    return node
  }

  /* ═══════ INTERNAL: TRAVERSAL ════════════════════════════════════ */

  _inOrder(node, cb) {
    if (!node) return
    this._inOrder(node.left, cb)
    cb(node.key, node.value)
    this._inOrder(node.right, cb)
  }

  _reverseInOrder(node, cb) {
    if (!node) return
    this._reverseInOrder(node.right, cb)
    cb(node.key, node.value)
    this._reverseInOrder(node.left, cb)
  }

  _inOrderN(node, result, n) {
    if (!node || result.length >= n) return
    this._inOrderN(node.left, result, n)
    if (result.length < n) result.push({ key: node.key, value: node.value })
    if (result.length < n) this._inOrderN(node.right, result, n)
  }

  _reverseInOrderN(node, result, n) {
    if (!node || result.length >= n) return
    this._reverseInOrderN(node.right, result, n)
    if (result.length < n) result.push({ key: node.key, value: node.value })
    if (result.length < n) this._reverseInOrderN(node.left, result, n)
  }

  /** Scan all nodes with key >= target, in ascending order. */
  _scanGE(node, target, cb) {
    if (!node) return
    const cmp = this.compare(target, node.key)
    if (cmp <= 0) {
      // target <= node.key → left subtree may have more >= target
      this._scanGE(node.left, target, cb)
      cb(node.key, node.value)
      // entire right subtree is > node.key >= target
      this._inOrder(node.right, cb)
    } else {
      // target > node.key → skip this node and left subtree
      this._scanGE(node.right, target, cb)
    }
  }

  /** Scan all nodes with key <= target, in ascending order. */
  _scanLE(node, target, cb) {
    if (!node) return
    const cmp = this.compare(target, node.key)
    if (cmp >= 0) {
      // target >= node.key → entire left subtree is < node.key <= target
      this._inOrder(node.left, cb)
      cb(node.key, node.value)
      // right subtree may have more <= target
      this._scanLE(node.right, target, cb)
    } else {
      // target < node.key → skip this node and right subtree
      this._scanLE(node.left, target, cb)
    }
  }

  /* ═══════ INTERNAL: ROTATIONS ════════════════════════════════════ */

  _rotateLeft(x) {
    const y = x.right
    x.right = y.left
    if (y.left) y.left.parent = x
    y.parent = x.parent
    if (!x.parent) {
      this.root = y
    } else if (x === x.parent.left) {
      x.parent.left = y
    } else {
      x.parent.right = y
    }
    y.left = x
    x.parent = y
  }

  _rotateRight(x) {
    const y = x.left
    x.left = y.right
    if (y.right) y.right.parent = x
    y.parent = x.parent
    if (!x.parent) {
      this.root = y
    } else if (x === x.parent.right) {
      x.parent.right = y
    } else {
      x.parent.left = y
    }
    y.right = x
    x.parent = y
  }

  /* ═══════ INTERNAL: INSERT FIX-UP ════════════════════════════════ */

  _fixInsert(z) {
    while (z !== this.root && z.parent.color === RED) {
      const parent      = z.parent
      const grandparent = parent.parent

      if (parent === grandparent.left) {
        const uncle = grandparent.right
        if (uncle && uncle.color === RED) {
          // Case 1: uncle is red → recolor
          parent.color      = BLACK
          uncle.color       = BLACK
          grandparent.color = RED
          z = grandparent
        } else {
          if (z === parent.right) {
            // Case 2: z is right child → rotate to make left child
            z = parent
            this._rotateLeft(z)
          }
          // Case 3: z is left child → rotate grandparent
          z.parent.color          = BLACK
          z.parent.parent.color   = RED
          this._rotateRight(z.parent.parent)
        }
      } else {
        // Mirror: parent is right child of grandparent
        const uncle = grandparent.left
        if (uncle && uncle.color === RED) {
          parent.color      = BLACK
          uncle.color       = BLACK
          grandparent.color = RED
          z = grandparent
        } else {
          if (z === parent.left) {
            z = parent
            this._rotateRight(z)
          }
          z.parent.color          = BLACK
          z.parent.parent.color   = RED
          this._rotateLeft(z.parent.parent)
        }
      }
    }
    this.root.color = BLACK
  }

  /* ═══════ INTERNAL: DELETE ═══════════════════════════════════════ */

  _transplant(u, v) {
    if (!u.parent) {
      this.root = v
    } else if (u === u.parent.left) {
      u.parent.left = v
    } else {
      u.parent.right = v
    }
    if (v) v.parent = u.parent
  }

  _deleteNode(z) {
    let y = z
    let yOrigColor = y.color
    let x, xParent

    if (!z.left) {
      x = z.right
      xParent = z.parent
      this._transplant(z, z.right)
    } else if (!z.right) {
      x = z.left
      xParent = z.parent
      this._transplant(z, z.left)
    } else {
      // Node has two children: find in-order successor
      y = this._minNode(z.right)
      yOrigColor = y.color
      x = y.right

      if (y.parent === z) {
        xParent = y
        if (x) x.parent = y
      } else {
        xParent = y.parent
        this._transplant(y, y.right)
        y.right = z.right
        y.right.parent = y
      }

      this._transplant(z, y)
      y.left = z.left
      y.left.parent = y
      y.color = z.color
    }

    if (yOrigColor === BLACK) {
      this._fixDelete(x, xParent)
    }
  }

  _fixDelete(x, xParent) {
    while (x !== this.root && (!x || x.color === BLACK)) {
      if (x === (xParent ? xParent.left : null)) {
        let w = xParent.right // sibling

        if (w && w.color === RED) {
          // Case 1: sibling is red
          w.color = BLACK
          xParent.color = RED
          this._rotateLeft(xParent)
          w = xParent.right
        }

        if ((!w?.left || w.left.color === BLACK) &&
            (!w?.right || w.right.color === BLACK)) {
          // Case 2: sibling's children are both black
          if (w) w.color = RED
          x = xParent
          xParent = x.parent
        } else {
          if (!w?.right || w.right.color === BLACK) {
            // Case 3: sibling's right child is black, left is red
            if (w?.left) w.left.color = BLACK
            if (w) w.color = RED
            if (w) this._rotateRight(w)
            w = xParent.right
          }
          // Case 4: sibling's right child is red
          if (w) w.color = xParent.color
          xParent.color = BLACK
          if (w?.right) w.right.color = BLACK
          this._rotateLeft(xParent)
          x = this.root // done
        }
      } else {
        // Mirror: x is right child
        let w = xParent.left

        if (w && w.color === RED) {
          w.color = BLACK
          xParent.color = RED
          this._rotateRight(xParent)
          w = xParent.left
        }

        if ((!w?.left || w.left.color === BLACK) &&
            (!w?.right || w.right.color === BLACK)) {
          if (w) w.color = RED
          x = xParent
          xParent = x.parent
        } else {
          if (!w?.left || w.left.color === BLACK) {
            if (w?.right) w.right.color = BLACK
            if (w) w.color = RED
            if (w) this._rotateLeft(w)
            w = xParent.left
          }
          if (w) w.color = xParent.color
          xParent.color = BLACK
          if (w?.left) w.left.color = BLACK
          this._rotateRight(xParent)
          x = this.root
        }
      }
    }
    if (x) x.color = BLACK
  }
}
