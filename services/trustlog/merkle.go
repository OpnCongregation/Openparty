package main

import (
	"bytes"
	"crypto/sha256"
	"errors"
)

// RFC 6962 Merkle tree hashing (standard certificate-transparency construction).

func hashLeaf(data []byte) []byte {
	h := sha256.New()
	h.Write([]byte{0x00})
	h.Write(data)
	return h.Sum(nil)
}

func hashChildren(l, r []byte) []byte {
	h := sha256.New()
	h.Write([]byte{0x01})
	h.Write(l)
	h.Write(r)
	return h.Sum(nil)
}

func emptyRoot() []byte {
	s := sha256.Sum256(nil)
	return s[:]
}

// largestPow2Below returns the largest power of two strictly less than n (n >= 2).
func largestPow2Below(n int) int {
	k := 1
	for k<<1 < n {
		k <<= 1
	}
	return k
}

// rootOf computes the Merkle tree hash over leaf hashes.
func rootOf(leaves [][]byte) []byte {
	switch len(leaves) {
	case 0:
		return emptyRoot()
	case 1:
		return leaves[0]
	}
	k := largestPow2Below(len(leaves))
	return hashChildren(rootOf(leaves[:k]), rootOf(leaves[k:]))
}

// inclusionProof returns the audit path for leaf m in a tree of the given leaves.
func inclusionProof(m int, leaves [][]byte) [][]byte {
	n := len(leaves)
	if n <= 1 {
		return nil
	}
	k := largestPow2Below(n)
	if m < k {
		return append(inclusionProof(m, leaves[:k]), rootOf(leaves[k:]))
	}
	return append(inclusionProof(m-k, leaves[k:]), rootOf(leaves[:k]))
}

// verifyInclusion checks an audit path against a root (RFC 6962 / RFC 9162 algorithm).
func verifyInclusion(leafHash []byte, index, size int, proof [][]byte, root []byte) error {
	if index < 0 || index >= size {
		return errors.New("index out of range")
	}
	fn, sn := index, size-1
	r := leafHash
	for _, p := range proof {
		if sn == 0 {
			return errors.New("proof too long")
		}
		if fn&1 == 1 || fn == sn {
			r = hashChildren(p, r)
			if fn&1 == 0 {
				for fn&1 == 0 && fn != 0 {
					fn >>= 1
					sn >>= 1
				}
			}
		} else {
			r = hashChildren(r, p)
		}
		fn >>= 1
		sn >>= 1
	}
	if sn != 0 {
		return errors.New("proof too short")
	}
	if !bytes.Equal(r, root) {
		return errors.New("root mismatch")
	}
	return nil
}

// consistencyProof returns the proof that the tree of size m is a prefix of the tree of size n.
func consistencyProof(m int, leaves [][]byte) [][]byte {
	n := len(leaves)
	if m <= 0 || m >= n {
		return nil
	}
	return subProof(m, leaves, true)
}

func subProof(m int, leaves [][]byte, complete bool) [][]byte {
	n := len(leaves)
	if m == n {
		if complete {
			return nil
		}
		return [][]byte{rootOf(leaves)}
	}
	k := largestPow2Below(n)
	if m <= k {
		return append(subProof(m, leaves[:k], complete), rootOf(leaves[k:]))
	}
	return append(subProof(m-k, leaves[k:], false), rootOf(leaves[:k]))
}

// verifyConsistency checks that oldRoot (size m) is a prefix of newRoot (size n).
func verifyConsistency(m, n int, oldRoot, newRoot []byte, proof [][]byte) error {
	if m == n {
		if len(proof) != 0 || !bytes.Equal(oldRoot, newRoot) {
			return errors.New("roots differ for equal sizes")
		}
		return nil
	}
	if m == 0 {
		return nil
	}
	if m > n {
		return errors.New("old size exceeds new size")
	}
	if len(proof) == 0 {
		return errors.New("empty proof")
	}
	path := proof
	if m&(m-1) == 0 {
		path = append([][]byte{oldRoot}, proof...)
	}
	fn, sn := m-1, n-1
	for fn&1 == 1 {
		fn >>= 1
		sn >>= 1
	}
	fr, sr := path[0], path[0]
	for _, c := range path[1:] {
		if sn == 0 {
			return errors.New("proof too long")
		}
		if fn&1 == 1 || fn == sn {
			fr = hashChildren(c, fr)
			sr = hashChildren(c, sr)
			for fn&1 == 0 && fn != 0 {
				fn >>= 1
				sn >>= 1
			}
		} else {
			sr = hashChildren(sr, c)
		}
		fn >>= 1
		sn >>= 1
	}
	if sn != 0 {
		return errors.New("proof too short")
	}
	if !bytes.Equal(fr, oldRoot) {
		return errors.New("old root mismatch")
	}
	if !bytes.Equal(sr, newRoot) {
		return errors.New("new root mismatch")
	}
	return nil
}
