export function dHash(frame: Uint8Array): bigint{
    let hash = 0n
    let bit = 0n
    //frame is 9x8, so 8 comparisons per row
    for (let row = 0; row < 8; row++){
        for (let col = 0; col < 8; col++){
            let left = frame[row * 9 + col]
            let right = frame[row * 9 + col + 1]
            if (left < right) hash |= 1n << bit
            bit ++
        }
    }
    return hash
}

export function hammingDistance(hash1: bigint, hash2: bigint): number{
    // compare hashes: return 1 if both bits are different, 0 if same, count that instances
    // ^ returns 1 if both bits are different, 0 if same
    // & returns 1 if both are 1
    let difference = 0
    let XOR = hash1 ^ hash2
    while (XOR > 0n){
        difference += Number(XOR & 1n)
        XOR >>= 1n
    }
    return difference
}

// takes in 2 Uint8Array[]
// takes fingerprint of each frame
// get hamming distance of the 2 fingerprints
// higher (hamming distance / 64) => less similar (so you'd want to invert this)
// but also, want to go from -3 to 0 to 3 offset

export function compareVideo(video1: Uint8Array[], video2: Uint8Array[]): number{
    if (video1.length == 0 || video2.length == 0) return 0;
    let minLength = Math.min(video1.length, video2.length)
    let minAvg = 100
    let currTotal = 0
    for (let i = -3; i < 3; i++){
        currTotal = 0
        for (let j = 0; j < minLength; j++){
            //compare video1[j] with video2[j + i]
            // but we must consider if j + i is out of bounds, either negative or too big
            if ((j + i) < 0) continue;
            if ((j + i ) >= minLength) continue;
            currTotal += hammingDistance(dHash(video1[j]), dHash(video2[j + i]))
        }
        let currAvg = currTotal / (minLength - Math.abs(i))
        if (currAvg < minAvg) minAvg = currAvg
    }
    return Math.round((100 - minAvg) * 100) / 100
}

export function compareVideoHashes(video1: bigint[], video2: bigint[]): number{
    if (video1.length == 0 || video2.length == 0){
        console.log('yo is this it?? is it because im gettin fucking length zero??')
        return 0
    }
    let minLength = Math.min(video1.length, video2.length)
    let minAvg = 100
    for (let offset = -3; offset < 3; offset ++){
        let currTotal = 0
        for (let i = 0; i < minLength; i ++){
            if ((i + offset) < 0) continue
            if ((i + offset) >= minLength) continue
            currTotal += hammingDistance(video1[i], video2[i + offset])
        }
        let currAvg = currTotal / (minLength - Math.abs(offset)) 
        if (currAvg < minAvg) minAvg = currAvg
    }
    return Math.round((100 - minAvg) * 100) / 100
}

export function normalizeText(text: string): string{
    return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[^\w\s]|_/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

export function shingle(text: string): string[]{
    //so i need to split text into array of words seperated by spaces
    let words = text.split(" ")
    let shingles: string[] = []
    let index = 0
    if (words.length < 3){
        return [text]
    }
    while (index <= words.length - 3){
        let wordGroup = ""
        for (let i = index; i < index + 3; i++){
            wordGroup += words[i] + " "
        }
        shingles.push(wordGroup.trim())
        index += 1
    }
    return shingles
}

// fnv-1a is a fast non cryptographic hashing algo
// XOR -> multiply -> mask -> repeat
// XOR with BASIS _> multiply with PRIME -> mask with hexadecimal
export function fnv1a(input: string): bigint{
    const FNV_OFFSET_BASIS = 14695981039346656037n
    const FNV_PRIME = 1099511628211n
    let hash = FNV_OFFSET_BASIS
    const bytes = new TextEncoder().encode(input)
    for (const byte of bytes){
        hash = hash ^ BigInt(byte)
        hash = (hash * FNV_PRIME) & 0xFFFFFFFFFFFFFFFFn
    }
    return hash
}

export function simHash(shingles: string[]): bigint{
    if (shingles.length === 0) return 0n
    let scoreBoard = new Array(64).fill(0)
    for (const shingle of shingles){
        let hash = fnv1a(shingle)
        for (let i = 0; i <= 63; i++){
            //turn the scoreBoard array into 64 positive or negative tallies
            //+1 if hash at that pos is 1
            //-1 if hash at that pos is 0
            //what do i need to do first?
            //go through hash and check out each number
            //so we loop through the index position
            //done
            //now, we see each position is indeed 1
            // ^? tee-totaler, must be different, nah
            // &? seatbelt, yes. 1 & 1!
            //lets do the first case
            if ((hash & 1n << BigInt(i)) != 0n) scoreBoard[i] += 1
            else scoreBoard[i] -= 1
        }
    }
    let finalBigInt = 0n
    //scoreboard holds positive or negative.
    //if its positive, put 1 in its place
    //if its negative, put 0
    for (let i = 0; i <= 63; i++){
        if (scoreBoard[i] > 0){
            finalBigInt = finalBigInt | 1n << BigInt(i)
        }
    }
    return finalBigInt
}